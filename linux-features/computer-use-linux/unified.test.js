"use strict";
const fs = require("node:fs");
const os = require("node:os");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const test = require("node:test");
const descriptors = require("./patch.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

// The current rspack selector boundary: unified prerequisites, platform, feature
// flag, Windows/macOS service availability, followed by independent browser
// selection. The builder mirrors the packaged cua-repl instructions path, which
// rebuilds the environment while keeping caller-provided services and banner.
const selector = [
  "function select(f,l,t,u){let p=f&&t.computerUse&&u.enabled&&(\"win32\"===l.platform||\"darwin\"===l.platform&&null!=u.paths.serviceAppPath),m=t.computerUse&&(!t.browserUseTinysky||\"darwin\"!==l.platform||u.enabled),h=[];return f&&t.browser&&h.push(\"browser\"),p&&h.push(\"computer\"),{computerUse:m,cuaReplSurfaces:h}}",
  "function build({browserBackends:b,deferTools:d,surfaces:s,nodeRepl:n,accessBootstrapPath:a}){let l={};s.includes(\"browser\")&&(l.browser=\"@oai/browser-desktop/service\"),s.includes(\"computer\")&&(l.sky=\"@oai/sky/service\");let o={...n?.env,CUA_REPL_ENABLED_SURFACES:s.join(\",\"),...n?.env.SKY_ENABLE_AUDIO===\"1\"?{SKY_ENABLE_AUDIO:s.includes(\"computer\")?\"1\":\"0\",NODE_REPL_ENABLE_AUDIO:s.includes(\"computer\")?n.env.NODE_REPL_ENABLE_AUDIO:\"0\"}:{},[constants.Il]:JSON.stringify(l)};return{env:function({env:e}){let t={};return t.sky=\"@oai/sky/service\",{...e,NODE_REPL_TRUSTED_SERVICES:e.NODE_REPL_TRUSTED_SERVICES??JSON.stringify(t),NODE_REPL_JS_BANNER:e.NODE_REPL_JS_BANNER??\"await import(\\\"@oai/cua/tinyskyAlt\\\");\"}}({env:o})}}",
  "let syncQueue=new WeakMap,pendingPlugins=new WeakMap;async function readCached(e,{waitForReconcile:wait=!0}={}){for(;;){let other=pendingPlugins.get(e);if(null!=other&&!wait)return null;let pending=syncQueue.get(e),value=await Promise.all([other,pending]).then(([,result])=>result??null,()=>null);if(other===pendingPlugins.get(e)&&pending===syncQueue.get(e))return value}}class PluginChange{constructor(e,t){this.options=e,this.onPluginsChanged=t}async syncAfterPluginChange(){let pending=initialize({...this.options,reloadUserConfig:!1});for(let outcome of(await Promise.allSettled([pending,this.onPluginsChanged?.()])))if(\"rejected\"===outcome.status)throw outcome.reason}}function initialize(e){let pending=(syncQueue.get(e.appServerConnection)??Promise.resolve()).catch(()=>{}).then(()=>(async function({appServerConnection:connection,selection:input}){let selection=input,features=selection.desktopFeatureAvailability,{codexHome:home,marketplaceName:marketplace,runtimePaths:runtime,browserBackends:backends,cuaReplSurfaces:surfaces}=selection,marketplaces=[],skip=!1,node=selection.nodeRepl,enabled=!1;enabled=await async function(e){let t=lookup(),enabled=null!=e.nodeRepl&&e.surfaces.length>0,i=(0,constants.Kt)({codexHome:e.codexHome,localVersion:t.plugin.localVersion,marketplaceName:t.marketplace.name,pluginName:t.plugin.name}),a=ei().join(i,\".mcp.json\"),bootstrap=ei().join(i,\"require-browser-access.mjs\"),c={};Object.assign(c,build({...e,accessBootstrapPath:bootstrap}));return enabled}({browserBackends:backends,deferTools:features.deferCuaTools,surfaces:surfaces,codexHome:home,marketplaceName:marketplace,marketplaces:marketplaces,nodeRepl:skip?void 0:node});return {selection:selection,cuaReplEnabled:enabled}})(e));return syncQueue.set(e.appServerConnection,pending),pending}async function startup(options){await initialize({appServerConnection:options.getLocalAppServerConnection(),appVersion:options.appVersion,getDesktopFeatureAvailability:()=>availability??defaults,isPackaged:options.isPackaged,platform:platform,repoRoot:options.repoRoot,resourcesPath:resources})}",
  "async function threadConfig(e){let{appServerConnection:connection}=e,local=\"local\"===connection.hostConfig.kind,cached=local?await readCached(connection,{waitForReconcile:!1}):null,features=e.features,posture=features.browserUseTinysky?cached:null,principal=local?await connection.getAuthenticatedPrincipal().catch(()=>null):null,selection=posture?.selection??await selectForThread(e);selection={...selection,browserServicePluginVersion:null};let node=e.nodeRepl??selection.nodeRepl;return posture?.cuaReplEnabled?build({browserBackends:selection.browserBackends,deferTools:selection.desktopFeatureAvailability.deferCuaTools,surfaces:selection.cuaReplSurfaces,nodeRepl:node}):{enabled:!1}}",
].join("");
const SERVICES = "NODE_REPL_TRUSTED_SERVICES";
const { applyUnifiedComputerUsePatch: unified } = require("./unified.js");
function patch(source) {
  const withFeature = descriptors.find(descriptor => descriptor.id === "ui-feature").apply(source);
  return unified(withFeature);
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
// Supply inert connection identities explicitly to the real queued functions.
// The returned cache object maps back to the same connection for thread reads.
function lifecycle(source, sandbox = context()) {
  const native = vm.runInNewContext(`${source};({initialize,threadConfig})`, sandbox);
  const connections = new WeakMap();
  return {
    async initialize(options) {
      const connection = options.appServerConnection ?? {
        hostConfig: { kind: "local" },
        getAuthenticatedPrincipal: async () => null,
      };
      const cached = await native.initialize({ ...options, appServerConnection: connection });
      connections.set(cached, connection);
      return cached;
    },
    threadConfig(options) {
      return native.threadConfig({ ...options,
        appServerConnection: options.appServerConnection ?? connections.get(options.cached) });
    },
  };
}

function surfaces(source, platform, { ready = true, enabled = true, legacy = false, nativeEnabled = true } = {}) {
  const select = vm.runInNewContext(`(${source.slice(0, source.indexOf("function build("))})`);
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
  const select = vm.runInNewContext(`(${patched.slice(0, patched.indexOf("function build("))})`);
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
  const environment = '{...n?.env,CUA_REPL_ENABLED_SURFACES:s.join(","),...n?.env.SKY_ENABLE_AUDIO==="1"?{SKY_ENABLE_AUDIO:s.includes("computer")?"1":"0",NODE_REPL_ENABLE_AUDIO:s.includes("computer")?n.env.NODE_REPL_ENABLE_AUDIO:"0"}:{},[constants.Il]:JSON.stringify(l)}';
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
    const { initialize, threadConfig } = lifecycle(patched, context({
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
  const { initialize, threadConfig } = lifecycle(patch(selector), context({
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
  const { initialize, threadConfig } = lifecycle(patch(selector), context());
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

test("unified audio environment preserves current upstream flags for every surface", () => {
  const original = vm.runInNewContext(`${selector};build`, context());
  const patched = unified(selector);
  const build = vm.runInNewContext(`${patched};build`, context());
  for (const enabledSurfaces of [[], ["browser"], ["computer"], ["browser", "computer"]]) {
    for (const skyAudio of [undefined, "0", "1"]) {
      for (const nodeAudio of [undefined, "0", "1"]) {
        const env = { unrelated: "retained" };
        if (skyAudio !== undefined) env.SKY_ENABLE_AUDIO = skyAudio;
        if (nodeAudio !== undefined) env.NODE_REPL_ENABLE_AUDIO = nodeAudio;
        const parameters = { browserBackends: ["native"], surfaces: enabledSurfaces, nodeRepl: { env } };
        const before = original(parameters).env;
        const after = build(parameters, "/trusted-plugin").env;
        assert.equal(after.SKY_ENABLE_AUDIO, before.SKY_ENABLE_AUDIO);
        assert.equal(after.NODE_REPL_ENABLE_AUDIO, before.NODE_REPL_ENABLE_AUDIO);
        assert.equal(after.unrelated, "retained");
        assert.equal(Object.hasOwn(after, "SKY_AUDIO_ATTACHMENTS"), false);
        assert.equal(Object.hasOwn(after, "NODE_REPL_ENABLE_AUDIO"),
          nodeAudio !== undefined || skyAudio === "1");
        const services = JSON.parse(after[SERVICES]);
        assert.equal(services.sky, enabledSurfaces.includes("computer")
          ? "/trusted-plugin/scripts/native-service.mjs" : undefined);
        assert.equal(services.browser, enabledSurfaces.includes("browser")
          ? "@oai/browser-desktop/service" : undefined);
        if (skyAudio === "1") {
          assert.equal(after.SKY_ENABLE_AUDIO, enabledSurfaces.includes("computer") ? "1" : "0");
          assert.equal(after.NODE_REPL_ENABLE_AUDIO, enabledSurfaces.includes("computer") ? nodeAudio : "0");
        }
      }
    }
  }
});

test("unified audio contract rejects retired and incomplete environment branches", () => {
  for (const changed of [
    selector.replace("n?.env.SKY_ENABLE_AUDIO", "n?.env.SKY_AUDIO_ATTACHMENTS"),
    selector.replace('NODE_REPL_ENABLE_AUDIO:s.includes("computer")?n.env.NODE_REPL_ENABLE_AUDIO:"0"',
      'NODE_REPL_ENABLE_AUDIO:"0"'),
    selector.replace('SKY_ENABLE_AUDIO:s.includes("computer")?"1":"0",', ""),
    selector.replace('NODE_REPL_ENABLE_AUDIO:s.includes("computer")?n.env.NODE_REPL_ENABLE_AUDIO:"0"',
      'NODE_REPL_ENABLE_AUDIO:s.includes("computer")?other.env.NODE_REPL_ENABLE_AUDIO:"0"'),
  ]) {
    assert.notEqual(changed, selector);
    assert.throws(() => unified(changed), /unified.*contract/i);
  }
  const patched = unified(selector);
  const partial = patched.replace('NODE_REPL_ENABLE_AUDIO:s.includes("computer")?n.env.NODE_REPL_ENABLE_AUDIO:"0"',
    'NODE_REPL_ENABLE_AUDIO:"0"');
  assert.notEqual(partial, patched);
  assert.throws(() => unified(partial), /unified.*contract/i);
});

test("unified propagation rejects missing, ambiguous, or changed builder consumers", () => {
  for (const changed of [
    selector + "build(extra)",
    selector + "const alias=build;",
    selector + "initialize(extra)",
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
  assert.doesNotThrow(() => patch(selector +
    'const serialized="build ap";const entities={ap:"approximately"};'));
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
    const end = selector.indexOf("let syncQueue=");
    const builder = selector.slice(start, end).replace(new RegExp(`\\b${binding}\\b`, "g"), "require");
    const shadowed = selector.slice(0, start) + builder + selector.slice(end);
    assert.throws(() => patch(shadowed), /native config builder shadows require/);
  }
});

function queuedRuntime(source, extra = {}) {
  return vm.runInNewContext(`${source};({initialize,threadConfig,syncQueue,pendingPlugins,readCached,PluginChange})`, context(extra));
}
function connection() {
  return { hostConfig: { kind: "local" }, getAuthenticatedPrincipal: async () => null };
}
function selected(home) {
  return { codexHome: home, marketplaceName: "bundled", runtimePaths: { platform: "linux" },
    browserBackends: ["native"], cuaReplSurfaces: ["computer"], nodeRepl: { env: {} },
    desktopFeatureAvailability: { deferCuaTools: true } };
}

test("current serialized queue keeps same-connection ordering and independent connections", async () => {
  const calls = [];
  const native = queuedRuntime(unified(selector), { constants: { Il: SERVICES, Kt: metadata => {
    calls.push(metadata.codexHome);
    return path.join(metadata.codexHome, "trusted-plugin");
  } } });
  const firstConnection = connection();
  const secondConnection = connection();
  let release;
  native.syncQueue.set(firstConnection, new Promise(resolve => { release = resolve; }));
  const first = native.initialize({ appServerConnection: firstConnection, selection: selected("/first") });
  const second = native.initialize({ appServerConnection: firstConnection, selection: selected("/second") });
  const independent = await native.initialize({ appServerConnection: secondConnection, selection: selected("/independent") });
  assert.deepEqual(calls, ["/independent"]);
  assert.equal(independent.selection.codexLinuxCuaPluginRoot, "/independent/trusted-plugin");
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual(calls, ["/independent", "/first", "/second"]);
  assert.equal(one.selection.codexLinuxCuaPluginRoot, "/first/trusted-plugin");
  assert.equal(two.selection.codexLinuxCuaPluginRoot, "/second/trusted-plugin");
  assert.equal(await native.readCached(firstConnection), two);
  assert.equal(await native.readCached(secondConnection), independent);
});

test("current queue resumes after rejection and preserves plugin-change failure propagation", async () => {
  const calls = [];
  const native = queuedRuntime(unified(selector), { constants: { Il: SERVICES, Kt: metadata => {
    calls.push(metadata.codexHome);
    if (metadata.codexHome === "/broken") throw new Error("configuration failed");
    return path.join(metadata.codexHome, "trusted-plugin");
  } } });
  const local = connection();
  const failed = native.initialize({ appServerConnection: local, selection: selected("/broken") });
  const recovered = native.initialize({ appServerConnection: local, selection: selected("/recovered") });
  await assert.rejects(failed, /configuration failed/);
  const cached = await recovered;
  assert.deepEqual(calls, ["/broken", "/recovered"]);
  assert.equal((await native.readCached(local)).selection, cached.selection);
  const controller = new native.PluginChange({ appServerConnection: local, selection: selected("/callback") },
    async () => { throw new Error("plugin callback failed"); });
  await assert.rejects(controller.syncAfterPluginChange(), /plugin callback failed/);
  assert.equal((await native.readCached(local)).selection.codexLinuxCuaPluginRoot, "/callback/trusted-plugin");
});

test("current cache reader retries changed synchronization and plugin-work snapshots", async () => {
  const native = queuedRuntime(unified(selector));
  const local = connection();
  const first = { selection: selected("/old"), cuaReplEnabled: true };
  const second = { selection: selected("/new"), cuaReplEnabled: true };
  let releaseOld, releaseNew;
  native.syncQueue.set(local, Promise.resolve(first));
  native.pendingPlugins.set(local, new Promise(resolve => { releaseOld = resolve; }));
  const read = native.readCached(local);
  native.syncQueue.set(local, Promise.resolve(second));
  native.pendingPlugins.set(local, new Promise(resolve => { releaseNew = resolve; }));
  releaseOld();
  let settled = false;
  read.then(() => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  releaseNew();
  assert.equal(await read, second);
});

test("current native non-waiting thread reads fall back during reconciliation", async () => {
  let fallbackReads=0;
  const native=queuedRuntime(unified(selector),{selectForThread:async()=>{fallbackReads++;return selected("/fallback")}});
  const local=connection(),cached={selection:selected("/cached"),cuaReplEnabled:true};
  native.syncQueue.set(local,Promise.resolve(cached));
  assert.equal(await native.readCached(local,{waitForReconcile:false}),cached);
  native.pendingPlugins.set(local,new Promise(()=>{}));
  assert.equal(await native.readCached(local,{waitForReconcile:false}),null);
  const result=await native.threadConfig({appServerConnection:local,features:{browserUseTinysky:true}});
  assert.equal(result.enabled,false);assert.equal(fallbackReads,1);
  for(const[from,to]of[
    ["{waitForReconcile:!1}","{waitForReconcile:!0}"],
    ["null!=other&&!wait","null!=other&&wait"],
    ["if(null!=other&&!wait)return null;",""],
    ["waitForReconcile:wait=!0","waitForReconcile:wait=!1"],
  ]){const changed=selector.replace(from,to);assert.notEqual(changed,selector);assert.throws(()=>unified(changed),/unified.*contract/i)}
});

test("native helper reference census ignores opaque vendor data and identifier-key properties", () => {
  const opaque = ';const table={initialize:"≈",build:"native",syncQueue:"queue",readCached:"cache"};const data="initialize build syncQueue readCached";const regexp=/initialize|build|syncQueue|readCached/;/* initialize build syncQueue readCached */';
  const patched = unified(selector + opaque);
  assert.equal(patched, unified(selector) + opaque);
  assert.equal(unified(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  for (const extra of [
    ";const alias=true?initialize:null;",
    ";const alias={initialize};",
    ";const alias=true?build:null;",
    ";const alias={syncQueue};",
  ]) assert.throws(() => unified(selector + extra), /unified.*contract/i);
});

test("current anonymous sync and queue roles refuse disconnected or replaced native relationships", () => {
  for (const [from, to] of [
    [".catch(()=>{}).then", ".then"],
    ["syncQueue.get(e.appServerConnection)", "syncQueue.get(other)"],
    ["syncQueue.set(e.appServerConnection,pending)", "syncQueue.set(other,pending)"],
    ["})(e));return syncQueue", "})(other));return syncQueue"],
    ["enabled=await async function(e)", "enabled=async function(e)"],
    ["reloadUserConfig:!1", "reloadUserConfig:!0"],
    ['throw outcome.reason', 'return outcome.reason'],
    ["getLocalAppServerConnection()", "getOtherConnection()"],
    ["other===pendingPlugins.get(e)", "other===pendingPlugins.get(otherConnection)"],
    ["return value}}", "return pending}}"],
    ["cached=local?await readCached(connection,{waitForReconcile:!1})", "cached=local?await readCached(otherConnection,{waitForReconcile:!1})"],
    ["posture=features.browserUseTinysky?cached:null", "posture=features.browserUseTinysky?other:null"],
    ["browserBackends:backends,cuaReplSurfaces:surfaces}=selection", "browserBackends:backends,cuaReplSurfaces:surfaces}=other"],
  ]) {
    const changed = selector.replace(from, to);
    assert.notEqual(changed, selector, from);
    assert.throws(() => unified(changed), /unified.*contract/i, from);
  }
  assert.throws(() => unified(selector + "const alias=readCached;"), /cache reader is aliased or rebound/);
  assert.throws(() => unified(selector + "const alias=initialize;"), /unexpected initialize consumers/);
});

test("current factory scopes retain strict prefix and canonical numeric identities", () => {
  for (const key of ["9e4", '"90000"', "0x15f90"]) {
    const source = `"use strict";exports.ids=[747],exports.modules={${key}(e,t,r){${selector}}};`;
    const patched = unified(source);
    assert.notEqual(patched, source);
    assert.equal(unified(patched), patched);
    assert.doesNotThrow(() => new vm.Script(patched));
  }
  assert.throws(() => unified(`exports.ids=[747],exports.modules={9e4(){${selector}},"90000"(){}};`), /Duplicate main factory identity/);
});

function extractedWorkspace(t, sources, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unified-native-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: enabled ? ["computer-use-linux"] : [] }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config })
    .filter(item => item.id === "feature:computer-use-linux:unified-runtime");
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, ".vite/build", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return { file, source };
  });
  const run = () => {
    const report = createPatchReport();
    report.enabledFeatures = enabled ? ["computer-use-linux"] : [];
    captureWarnings(() => applyExtractedAppPatchDescriptors(root, loaded, {}, report, "extracted-app:pre-webview"));
    return report;
  };
  return { root, files, loaded, run };
}
const mainChunk = (body = selector, identity = "61071") => `exports.ids=[747],exports.modules={${identity}(e,t,r){${body}}};`;

test("registered unified descriptor applies one complete native cohort and repeats", t => {
  const project = extractedWorkspace(t, { "early-bootstrap.js": "const entry=true;", "early-bootstrap-747-abcdef12.js": mainChunk() });
  assert.equal(project.loaded.length, 1);
  assert.equal(project.loaded[0].phase, "extracted-app:pre-webview");
  assert.equal(project.run().patches[0].status, "applied");
  assert.equal(fs.readFileSync(project.files[1].file, "utf8"), unified(project.files[1].source));
  assert.equal(project.run().patches[0].status, "already-applied");
});

test("registered unified descriptor refuses missing, duplicate and damaged native cohorts before writes", t => {
  for (const sources of [
    { "early-bootstrap.js": "const entry=true;" },
    { "early-bootstrap-747-abcdef12.js": mainChunk(), "early-bootstrap-999-abcdef12.js": mainChunk() },
    { "early-bootstrap-747-abcdef12.js": mainChunk(), "early-bootstrap-999-abcdef12.js": mainChunk("return false;", '"61071"') },
    { "early-bootstrap-747-abcdef12.js": mainChunk(), "early-bootstrap-999-abcdef12.js": mainChunk(selector.replace(".catch(()=>{}).then", ".then")) },
    { "early-bootstrap-747-abcdef12.js": mainChunk(), "early-bootstrap-999-abcdef12.js": mainChunk(unified(selector)) },
  ]) {
    const project = extractedWorkspace(t, sources);
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    for (const { file, source } of project.files) assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("registered unified descriptor restores a truncated native owner write", t => {
  const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": mainChunk() });
  const originalWrite = fs.writeFileSync;
  let failed = false;
  t.mock.method(fs, "writeFileSync", (file, bytes, ...args) => {
    if (file === project.files[0].file && !failed) {
      failed = true;
      originalWrite(file, "truncated");
      throw new Error("injected native owner write failure");
    }
    return originalWrite(file, bytes, ...args);
  });
  assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
  assert.equal(failed, true);
  assert.equal(fs.readFileSync(project.files[0].file, "utf8"), project.files[0].source);
});

test("disabled unified feature performs no native inventory discovery", t => {
  const project = extractedWorkspace(t, {}, false);
  assert.deepEqual(project.loaded, []);
  let discovered = false;
  t.mock.method(fs, "readdirSync", () => { discovered = true; throw new Error("unexpected native inventory"); });
  assert.deepEqual(project.run().patches, []);
  assert.equal(discovered, false);
});

test("latest signed unified owner applies through all current main chunks without changing trusted inputs", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const original = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
  const inventory = findMainProcessChunks(original);
  assert.equal(inventory.chunks.length, 21);
  const sources = Object.fromEntries(inventory.chunks.map(name =>
    [name, fs.readFileSync(path.join(inventory.buildDir, name), "utf8")]));
  const project = extractedWorkspace(t, sources);
  assert.equal(project.run().patches[0].status, "applied");
  const changed = project.files.filter(({ file, source }) => fs.readFileSync(file, "utf8") !== source);
  assert.equal(changed.length, 1);
  assert.equal(fs.readFileSync(changed[0].file, "utf8"), unified(changed[0].source));
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(changed[0].file, "utf8")));
  assert.equal(project.run().patches[0].status, "already-applied");
  for (const [name, source] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(inventory.buildDir, name), "utf8"), source);
});

function nativeFunctions(source, target) {
  const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
  const functions = [];
  for (const header of source.matchAll(/(?:async )?function(?: (?<name>[A-Za-z_$][\w$]*))?\((?<parameters>[^)]*)\)\{/gu)) {
    if (header.index > target) break;
    const open = header.index + header[0].length - 1;
    const end = findMatchingBrace(source, open);
    if (end >= target) functions.push({ start: header.index, end: end + 1, name: header.groups.name,
      parameters: header.groups.parameters, source: source.slice(header.index, end + 1) });
  }
  return functions.sort((left, right) => left.end - left.start - (right.end - right.start));
}

function actualConfigFunctions(source) {
  const id = "[A-Za-z_$][\\w$]*";
  const call = [...source.matchAll(new RegExp(`Object\\.assign\\(${id},(?<builder>${id})\\(\\{\\.\\.\\.${id},accessBootstrapPath:${id}\\}`, "g"))];
  assert.equal(call.length, 1);
  const config = nativeFunctions(source, call[0].index)[0];
  assert.equal(config.name, undefined);
  const builderStart = source.indexOf(`function ${call[0].groups.builder}(`);
  const builder = nativeFunctions(source, builderStart)[0];
  assert.equal(builder.name, call[0].groups.builder);
  return { config, builder };
}

function actualConfigRuntime(source) {
  const { config, builder } = actualConfigFunctions(source);
  const id = "[A-Za-z_$][\\w$]*";
  const one = (pattern, input = config.source) => {
    const matches = [...input.matchAll(new RegExp(pattern, "g"))];
    assert.equal(matches.length, 1, pattern);
    return matches[0].groups;
  };
  const writes = [], renames = [], roots = [];
  let installed = true;
  const sandbox = {
    URL: require("node:url").URL,
    require: name => { assert.equal(name, "node:path"); return path; },
    process: { platform: "linux", execPath: "node", env: { CODEX_LINUX_CUA_HOST_SOCKET: "/runtime/cua.sock" } },
  };
  const namespace = name => sandbox[name] ??= {};
  const lookup = one(`let ${id}=(?<lookup>${id})\\(\\{marketplaceName:${id}\\.marketplaceName,marketplaces:${id}\\.marketplaces,pluginName:(?<namespace>${id})\\.(?<key>${id})\\}\\)`);
  namespace(lookup.namespace)[lookup.key] = "cua";
  sandbox[lookup.lookup] = () => ({ plugin: { installed, name: "cua", localVersion: "verified-version" }, marketplace: { name: "bundled" } });
  const root = one(`\\(0,(?<namespace>${id})\\.(?<key>${id})\\)\\(\\{codexHome:${id}\\.codexHome,localVersion:`);
  namespace(root.namespace)[root.key] = metadata => { roots.push(metadata); return path.join(metadata.codexHome, "trusted-plugin"); };
  const paths = one(`(?<factory>${id})\\(\\)\\.join\\(${id},"\\.mcp\\.json"\\)`);
  sandbox[paths.factory] = () => path;
  const io = one(`\\(0,(?<namespace>${id})\\.readFile\\)\\(${id},"utf8"\\)`);
  Object.assign(namespace(io.namespace), {
    readFile: async () => JSON.stringify({ mcpServers: { cua_repl: { unrelated: "kept" } } }),
    writeFile: async (file, content) => { writes.push({ file, content }); },
    rename: async (from, to) => { renames.push({ from, to }); },
  });
  const random = [...config.source.matchAll(new RegExp(`\\(0,(?<namespace>${id})\\.randomUUID\\)\\(\\)`, "g"))];
  assert.ok(random.length > 0);
  let serial = 0;
  for (const match of random) namespace(match.groups.namespace).randomUUID = () => `inert-${serial++}`;
  const schema = one(`(?<schema>${id})\\.parse\\(JSON\\.parse\\(${id}\\)\\)`);
  sandbox[schema.schema] = { parse: value => value };
  const services = one(`\\[(?<namespace>${id})\\.(?<key>${id})\\]:JSON\\.stringify\\(${id}\\)`, builder.source);
  namespace(services.namespace)[services.key] = SERVICES;
  const backendKey = one(`\\[(?<namespace>${id})\\.(?<key>${id})\\]:${id}\\.join\\(","\\)`, builder.source);
  namespace(backendKey.namespace)[backendKey.key] = "BROWSER_USE_AVAILABLE_BACKENDS";
  const packageRoot = one(`\\.env\\[(?<namespace>${id})\\.(?<key>${id})\\],"@oai/cua-repl"`, builder.source);
  namespace(packageRoot.namespace)[packageRoot.key] = "NODE_REPL_PACKAGE_ROOT";
  const command = one(`command:${id}\\.env\\[(?<namespace>${id})\\.(?<key>${id})\\]`, builder.source);
  namespace(command.namespace)[command.key] = "NODE_REPL_COMMAND";
  const instructionIo = one(`\\(0,(?<namespace>${id})\\.readFileSync\\)\\(new URL\\("banner\\.js"`, builder.source);
  namespace(instructionIo.namespace).readFileSync = () => "inert native instructions";
  const url = [...builder.source.matchAll(new RegExp(`\\(0,(?<namespace>${id})\\.pathToFileURL\\)`, "g"))];
  assert.ok(url.length > 0);
  for (const match of url) namespace(match.groups.namespace).pathToFileURL = require("node:url").pathToFileURL;
  const platforms = one(`(?<mapping>${id})\\[${id}\\];if\\(!${id}\\)throw Error`, builder.source);
  sandbox[platforms.mapping] = { linux: "linux", darwin: "macos", win32: "windows" };
  const runtime = vm.runInNewContext(`${builder.source};({configure:(${config.source}),build:${builder.name}})`, sandbox);
  return { ...runtime, writes, renames, roots, setInstalled(value) { installed = value; } };
}

test("latest actual anonymous configuration and builder preserve trusted root, audio and failure behavior", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const originals = inventory.chunks.map(name => fs.readFileSync(path.join(inventory.buildDir, name), "utf8"));
  const owners = originals.filter(source => source.includes("cuaReplSurfaces:") && source.includes("syncAfterPluginChange()"));
  const changed = owners.map(source => ({ source, patched: unified(source) })).filter(item => item.patched !== item.source);
  assert.equal(changed.length, 1);
  const original = actualConfigRuntime(changed[0].source);
  const patched = actualConfigRuntime(changed[0].patched);
  for (const surfaces of [[], ["browser"], ["computer"], ["browser", "computer"]]) {
    for (const skyAudio of [undefined, "0", "1"]) {
      for (const nodeAudio of [undefined, "0", "1"]) {
        const env = { NODE_REPL_PACKAGE_ROOT: "/vendor", unrelated: "kept" };
        if (skyAudio !== undefined) env.SKY_ENABLE_AUDIO = skyAudio;
        if (nodeAudio !== undefined) env.NODE_REPL_ENABLE_AUDIO = nodeAudio;
        const options = { browserBackends: ["native"], surfaces, nodeRepl: { command: "node", args: [], env } };
        const before = original.build(options);
        const after = patched.build(options, "/actual/trusted-plugin");
        assert.equal(after.env.SKY_ENABLE_AUDIO, before.env.SKY_ENABLE_AUDIO);
        assert.equal(after.env.NODE_REPL_ENABLE_AUDIO, before.env.NODE_REPL_ENABLE_AUDIO);
        assert.equal(after.env.unrelated, before.env.unrelated);
      }
    }
  }
  const cachedSelection = {};
  const options = { browserBackends: ["native"], deferTools: true, surfaces: ["computer"], codexHome: "/actual",
    marketplaceName: "bundled", marketplaces: [], nodeRepl: { command: "node", args: [], env: {
      NODE_REPL_PACKAGE_ROOT: "/vendor", SKY_ENABLE_AUDIO: "1", NODE_REPL_ENABLE_AUDIO: "1" } },
    codexLinuxCuaContext: cachedSelection };
  assert.equal(await patched.configure(options), true);
  assert.equal(cachedSelection.codexLinuxCuaPluginRoot, "/actual/trusted-plugin");
  assert.equal(patched.roots.length, 1);
  assert.equal(patched.roots[0].localVersion, "verified-version");
  assert.equal(patched.roots[0].codexHome, "/actual");
  const saved = patched.writes.find(item => item.file.includes(".mcp.json.tmp-"));
  assert.ok(saved);
  const config = JSON.parse(saved.content).mcpServers.cua_repl;
  assert.equal(config.unrelated, "kept");
  assert.equal(JSON.parse(config.env[SERVICES]).sky, "/actual/trusted-plugin/scripts/native-service.mjs");
  assert.equal(config.env.CODEX_LINUX_CUA_HOST_SOCKET, "/runtime/cua.sock");
  assert.ok(config.env.NODE_REPL_JS_BANNER.includes("/actual/trusted-plugin/scripts/native-client.mjs"));
  assert.equal(config.env.SKY_ENABLE_AUDIO, "1");
  assert.equal(config.env.NODE_REPL_ENABLE_AUDIO, "1");
  const notInstalled = actualConfigRuntime(changed[0].patched);
  notInstalled.setInstalled(false);
  assert.equal(await notInstalled.configure(options), false);
  assert.equal(notInstalled.writes.length, 0);
  assert.equal(notInstalled.roots.length, 0);
});

function inactiveDeclaration(source, name, nested = false) {
  const header = new RegExp(`(?:async )?function ${name}\\([^)]*\\)\\{`, "g");
  const matches = [...source.matchAll(header)];
  assert.equal(matches.length, 1);
  const owner = nativeFunctions(source, matches[0].index)[0];
  assert.equal(owner.name, name);
  const replacement = nested ? `function unusedOwner(){${owner.source}}` : `const unusedOwner=${owner.source};`;
  return source.slice(0, owner.start) + replacement + source.slice(owner.end);
}

test("native helper roles require active factory-root declarations in pure and registered entries", t => {
  t.mock.method(console, "warn", () => {});
  for (const name of ["build", "initialize", "readCached", "threadConfig"]) {
    for (const nested of [false, true]) {
      const source = inactiveDeclaration(selector, name, nested);
      assert.doesNotThrow(() => new vm.Script(source));
      assert.throws(() => unified(source), /native.*(?:root|declaration|nested)/);
      const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": mainChunk(source) });
      assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
      assert.equal(fs.readFileSync(project.files[0].file, "utf8"), project.files[0].source);
    }
  }
});

test("native helper declarations reject decoded Unicode binding writes", t => {
  t.mock.method(console, "warn", () => {});
  for (const name of ["build", "initialize", "readCached", "threadConfig"]) {
    const escaped = name.slice(0, -1) + "\\u" + name.charCodeAt(name.length - 1).toString(16).padStart(4, "0");
    const source = selector + `${escaped}=()=>null;`;
    assert.doesNotThrow(() => new vm.Script(source));
    assert.throws(() => unified(source), /binding is shadowed or written/);
    const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": mainChunk(source) });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    assert.equal(fs.readFileSync(project.files[0].file, "utf8"), project.files[0].source);
  }
});

test("latest actual builder, queue, cache reader and resume roles reject inactive named expressions", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  t.mock.method(console, "warn", () => {});
  const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const candidates = inventory.chunks.map(name => ({ name, source: fs.readFileSync(path.join(inventory.buildDir, name), "utf8") }));
  const owners = candidates.filter(item => item.source.includes("syncAfterPluginChange()") && item.source.includes("cuaReplSurfaces:"));
  const [{ source }] = owners.filter(item => {
    try { return unified(item.source) !== item.source; } catch { return false; }
  });
  const functions = actualConfigFunctions(source);
  const parent = nativeFunctions(source, functions.config.start - 1)[0];
  const queue = nativeFunctions(source, parent.start - 1)[0];
  const id = "[A-Za-z_$][\\w$]*";
  const resumeCall = [...source.matchAll(new RegExp(`${functions.builder.name}\\(\\{browserBackends:${id}\\.browserBackends`, "g"))];
  assert.equal(resumeCall.length, 1);
  const resume = nativeFunctions(source, resumeCall[0].index)[0];
  const readerCall = /\?await ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,\{waitForReconcile:!1\}\):null,/.exec(resume.source);
  assert.ok(readerCall);
  for (const name of [functions.builder.name, queue.name, readerCall[1], resume.name]) {
    const mutant = inactiveDeclaration(source, name);
    assert.doesNotThrow(() => new vm.Script(mutant));
    assert.throws(() => unified(mutant), /native.*(?:root|declaration|nested)/);
    const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": mutant });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    assert.equal(fs.readFileSync(project.files[0].file, "utf8"), mutant);
  }
});

test("native root bindings remain distinct from unrelated private class members", () => {
  const source = selector + 'class Unrelated{#build(){return 1}#initialize(){return 2}#readCached(){return 3}#threadConfig(){return 4}run(){return this.#build()+this.#initialize()+this.#readCached()+this.#threadConfig()}}';
  const patched = unified(source);
  assert.notEqual(patched, source);
  assert.equal(unified(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("ordinary builder and queue reject async modifiers separated by comments or whitespace", t => {
  t.mock.method(console, "warn", () => {});
  for (const name of ["build", "initialize"]) {
    for (const modifier of ["async ", "async/*gap*/", "async\t", "async /**/ "]) {
      const source = selector.replace(`function ${name}(`, `${modifier}function ${name}(`);
      assert.doesNotThrow(() => new vm.Script(source));
      assert.throws(() => unified(source), /ordinary.*(?:builder|queue)/);
      const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": mainChunk(source) });
      assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
      assert.equal(fs.readFileSync(project.files[0].file, "utf8"), project.files[0].source);
    }
  }
  const ordinary = selector.replace("function build(", "/*async*/function build(");
  assert.notEqual(unified(ordinary), ordinary);
});

test("latest actual ordinary builder and queue refuse comment and tab separated async kinds", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  t.mock.method(console, "warn", () => {});
  const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const candidates = inventory.chunks.map(name => fs.readFileSync(path.join(inventory.buildDir, name), "utf8"));
  const source = candidates.find(item => {
    if (!item.includes("syncAfterPluginChange()") || !item.includes("cuaReplSurfaces:")) return false;
    try { return unified(item) !== item; } catch { return false; }
  });
  assert.ok(source);
  const functions = actualConfigFunctions(source);
  const initializer = nativeFunctions(source, functions.config.start - 1)[0];
  const queue = nativeFunctions(source, initializer.start - 1)[0];
  for (const owner of [functions.builder, queue]) {
    for (const modifier of ["async/*gap*/", "async\t"]) {
      const mutant = source.slice(0, owner.start) + modifier + source.slice(owner.start);
      assert.doesNotThrow(() => new vm.Script(mutant));
      const callable = vm.runInNewContext(`(${modifier}${owner.source})`);
      assert.equal(callable.constructor.name, "AsyncFunction");
      assert.throws(() => unified(mutant), /ordinary.*(?:builder|queue)/);
      const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": mutant });
      assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
      assert.equal(fs.readFileSync(project.files[0].file, "utf8"), mutant);
    }
  }
});
