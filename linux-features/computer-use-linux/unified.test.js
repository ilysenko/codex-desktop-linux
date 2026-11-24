"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

const fixture = [
  'let keys={services:"NODE_REPL_TRUSTED_SERVICES"},pluginIds={cua:"cua"},banner="fallback";',
  'let plugins={root:({localVersion:e})=>`/verified/${e}`};',
  'function lookup({marketplaces:e,pluginName:t}){return e.find(e=>e.plugin.name===t)}',
  'function build({browserBackends:b,deferTools:d,confirmationPolicyConfig:c="{}",omitCuaConfirmationPolicyBySku:q,surfaces:s,nodeRepl:n,sharedPlugin:a=!1}){',
  'let o={};s.includes("browser")&&(o.browser="@oai/browser-desktop/service"),s.includes("computer")&&(o.sky="@oai/sky/service");',
  'let env={CUA_REPL_ENABLED_SURFACES:s.join(","),[keys.services]:JSON.stringify(o)};',
  'function packaged(e,fail){try{if(fail)throw Error("instructions unavailable")}catch{}return{NODE_REPL_TRUSTED_SERVICES:e.NODE_REPL_TRUSTED_SERVICES??JSON.stringify(o),NODE_REPL_JS_BANNER:e.NODE_REPL_JS_BANNER??banner}}',
  'return{env,packaged}}',
  'async function synchronize(root,e){return root}',
  'async function initialize(e){let g=e.marketplaces,f=await select(),{codexHome:w,marketplaceName:y,runtimePaths:z,browserBackends:v,cuaReplSurfaces:S}=f;',
  'let k=await thread({appServerConnection:e,appVersion:z,selection:f,hostServicesPipePath:null,includePrivateProcessEnv:!1});globalThis.lastThread=k;',
  'let t={browserBackends:v,deferTools:true,confirmationPolicyConfig:"{}",omitCuaConfirmationPolicyBySku:false,surfaces:S,nodeRepl:k["mcp_servers.node_repl"]};',
  'let x=await async function(e){let p=lookup({marketplaceName:e.marketplaceName,marketplaces:e.marketplaces,pluginName:pluginIds.cua});if(!p?.plugin.installed)return!1;',
  'let r=(0,plugins.root)({codexHome:e.codexHome,localVersion:p.plugin.localVersion,marketplaceName:p.marketplace.name,pluginName:p.plugin.name});',
  'return await synchronize(r,e)}({...t,codexHome:w,marketplaceName:y,marketplaces:g});',
  'let C=true,I="{}";return await e.sendAppServerRequest("config/batchWrite",{edits:[],expectedVersion:null}),{selection:f,cuaReplEnabled:C,executorLaunch:x,confirmationPolicyConfig:I}}',
  'async function thread({appServerConnection:e,appVersion:t,selection:r,verifyBrowserService:n=!1,includePrivateProcessEnv:i=!0,hostServicesPipePath:h=null}){',
  'let{codexHome:a,marketplaceName:o,browserServicePluginVersion:l,desktopFeatureAvailability:c,runtimePaths:d,shouldUseWslPaths:u,browserBackends:b,computerUse:p,computerUsePaths:m}=r;',
  'let v=null,q={env:{[keys.services]:null!=v||p?JSON.stringify({...null==v?{}:{browser:v},...p?{sky:"@oai/sky/service"}:{}}):void 0}},y={"mcp_servers.node_repl":q};',
  'if(null==y)return null;return y}',
  'async function resume(s){let o=s?.selection??await select(),c={env:{}};',
  'return build({browserBackends:o.browserBackends,deferTools:o.desktopFeatureAvailability.deferCuaTools,confirmationPolicyConfig:s.confirmationPolicyConfig,omitCuaConfirmationPolicyBySku:o.desktopFeatureAvailability.omitCuaConfirmationPolicyBySku,surfaces:o.cuaReplSurfaces,nodeRepl:c})}',
  'async function select(){let u=true,t={computerUse:true,browserUseTinysky:true},c={enabled:true,paths:{serviceAppPath:null}},o={platform:"linux"},h=u&&t.computerUse&&c.enabled&&("win32"===o.platform||"darwin"===o.platform&&null!=c.paths.serviceAppPath),p=t.computerUse&&(!t.browserUseTinysky||"darwin"!==o.platform||c.enabled),m=[];',
  'h&&m.push("computer");return{codexHome:"/codex",marketplaceName:"m",browserServicePluginVersion:null,desktopFeatureAvailability:{deferCuaTools:false,omitCuaConfirmationPolicyBySku:false},runtimePaths:o,shouldUseWslPaths:false,browserBackends:[],computerUse:p,computerUsePaths:c.paths,cuaReplSurfaces:m}}',
  'globalThis.api={initialize,resume,select,getLastThread:()=>globalThis.lastThread};',
].join("");

function execute(patched) {
  const context = { require, process: { platform: "linux", env: { CODEX_LINUX_CUA_HOST_SOCKET: "/host.sock" } } };
  new vm.Script(patched).runInNewContext(context);
  return context.api;
}

test("current unified contract enables Linux and propagates the verified plugin root", () => {
  const patched = applyUnifiedComputerUsePatch(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(applyUnifiedComputerUsePatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.match(patched, /"linux"===o\.platform\?h:/u);
  assert.equal(patched.split("codexLinuxUnifiedCuaBuilder").length, 2);
  assert.equal(patched.split("codexLinuxUnifiedCuaRoot").length, 2);
  assert.equal(patched.split("codexLinuxUnifiedCuaThread").length, 2);
  assert.equal(patched.split("codexLinuxUnifiedCuaStartup").length, 2);
  assert.match(patched, /require\("node:path"\)\.join\(codexLinuxCuaPluginRoot,"scripts","native-service\.mjs"\)/u);
  assert.match(patched, /codexLinuxCuaContext:f/u);
  assert.match(patched, /codexLinuxCuaPluginRoot:o\.codexLinuxCuaPluginRoot/u);
});

test("first initialization publishes the verified root before configuring the Linux thread", async () => {
  const api = execute(applyUnifiedComputerUsePatch(fixture));
  const result = await api.initialize({
    marketplaces: [{ marketplace: { name: "m" }, plugin: { name: "cua", installed: true, localVersion: "v" } }],
    sendAppServerRequest: async () => null,
  });
  assert.equal(result.selection.codexLinuxCuaPluginRoot, "/verified/v");
  const env = api.getLastThread()["mcp_servers.node_repl"].env;
  assert.equal(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES).sky, "/verified/v/scripts/native-service.mjs");
  assert.match(env.NODE_REPL_JS_BANNER, /\/verified\/v\/scripts\/native-client\.mjs/u);
  assert.equal(env.CODEX_LINUX_CUA_HOST_SOCKET, "/host.sock");
});

test("cached resume and packaged instruction fallbacks retain the verified bridge", async () => {
  const api = execute(applyUnifiedComputerUsePatch(fixture));
  const cached = await api.initialize({
    marketplaces: [{ marketplace: { name: "m" }, plugin: { name: "cua", installed: true, localVersion: "v" } }],
    sendAppServerRequest: async () => null,
  });
  const resumed = await api.resume(cached);
  assert.equal(JSON.parse(resumed.env.NODE_REPL_TRUSTED_SERVICES).sky, "/verified/v/scripts/native-service.mjs");
  for (const instructionsUnavailable of [false, true]) {
    const packaged = resumed.packaged(resumed.env, instructionsUnavailable);
    assert.equal(JSON.parse(packaged.NODE_REPL_TRUSTED_SERVICES).sky, "/verified/v/scripts/native-service.mjs");
    assert.match(packaged.NODE_REPL_JS_BANNER, /\/verified\/v\/scripts\/native-client\.mjs/u);
  }
});

test("Linux Computer Use fails closed without a verified plugin root", async () => {
  const api = execute(applyUnifiedComputerUsePatch(fixture));
  await assert.rejects(() => api.initialize({
    marketplaces: [{ marketplace: { name: "m" }, plugin: { name: "cua", installed: false, localVersion: "v" } }],
    sendAppServerRequest: async () => null,
  }), /trusted plugin root is unavailable/u);
  const selection = await api.select();
  await assert.rejects(() => api.resume({ selection, confirmationPolicyConfig: "{}" }),
    /trusted plugin root is unavailable/u);
});

test("changed or ambiguous semantic owners fail closed", () => {
  for (const changed of [
    fixture + fixture,
    fixture.replace('o.sky="@oai/sky/service"', 'o.sky="@oai/changed/service"'),
    fixture.replace("confirmationPolicyConfig:c=", "changedPolicy:c="),
    fixture.replace('sky:"@oai/sky/service"', 'sky:"@oai/changed/service"'),
  ]) {
    assert.throws(() => applyUnifiedComputerUsePatch(changed), /unified Computer Use contract drift/u);
  }
});

test("a previous-head patch without startup root publication fails closed", () => {
  const patched = applyUnifiedComputerUsePatch(fixture);
  const previousHead = patched.replace(
    /\/\*codexLinuxUnifiedCuaStartup\*\/\("linux"===f\.runtimePaths\.platform&&f\.computerUse&&\(\(\)=>\{[\s\S]*?\}\)\(\),thread\(\{appServerConnection:e,appVersion:z,selection:f,hostServicesPipePath:null,includePrivateProcessEnv:!1\}\)\)/u,
    "thread({appServerConnection:e,appVersion:z,selection:f,hostServicesPipePath:null,includePrivateProcessEnv:!1})",
  );
  assert.notEqual(previousHead, patched);
  assert.doesNotMatch(previousHead, /codexLinuxUnifiedCuaStartup/u);
  assert.throws(() => applyUnifiedComputerUsePatch(previousHead), /partial unified Computer Use patch/u);

  const damagedStartup = patched.replace("f.codexLinuxCuaPluginRoot=(0,plugins.root)",
    "f.changedRoot=(0,plugins.root)");
  assert.notEqual(damagedStartup, patched);
  assert.throws(() => applyUnifiedComputerUsePatch(damagedStartup),
    /startup verified-root publication matched 0 times/u);
});

test("startup injection rejects a synchronization-local plugin lookup", () => {
  const scopedLookup = fixture
    .replace('function lookup({marketplaces:e,pluginName:t}){return e.find(e=>e.plugin.name===t)}', "")
    .replace(
      "async function synchronize(root,e){return root}",
      'async function synchronize(root,e){function lookup({marketplaces:e,pluginName:t}){return e.find(e=>e.plugin.name===t)}return root}',
    );
  assert.throws(() => applyUnifiedComputerUsePatch(scopedLookup),
    /plugin lookup binding lookup is not accessible from startup owner/u);
});

test("startup injection rejects a plugin lookup scoped to a later block", () => {
  for (const declaration of [
    "function lookup({marketplaces:e,pluginName:t}){return e.find(e=>e.plugin.name===t)}",
    "let lookup=({marketplaces:e,pluginName:t})=>e.find(e=>e.plugin.name===t);",
    "const lookup=({marketplaces:e,pluginName:t})=>e.find(e=>e.plugin.name===t);",
  ]) {
    const blockScopedLookup = fixture
      .replace('function lookup({marketplaces:e,pluginName:t}){return e.find(e=>e.plugin.name===t)}', "")
      .replace(
        "let x=await async function(e){let p=lookup",
        `let x;{${declaration}x=await async function(e){let p=lookup`,
      )
      .replace(
        "marketplaces:g});let C=true",
        "marketplaces:g})};let C=true",
      );
    assert.doesNotThrow(() => new vm.Script(blockScopedLookup));
    assert.throws(() => applyUnifiedComputerUsePatch(blockScopedLookup),
      /plugin lookup binding lookup is not accessible from startup owner/u);
  }
});

test("startup injection rejects an unrelated accessible lookup shadowed by the semantic lookup", () => {
  const shadowedLookup = fixture
    .replace(
      'function lookup({marketplaces:e,pluginName:t}){return e.find(e=>e.plugin.name===t)}',
      "function lookup(){return null}",
    )
    .replace(
      "let x=await async function(e){let p=lookup",
      "let x;{const lookup=({marketplaces:e,pluginName:t})=>e.find(e=>e.plugin.name===t);" +
        "x=await async function(e){let p=lookup",
    )
    .replace(
      "marketplaces:g});let C=true",
      "marketplaces:g})};let C=true",
    );
  assert.doesNotThrow(() => new vm.Script(shadowedLookup));
  let unchanged = shadowedLookup;
  assert.throws(() => { unchanged = applyUnifiedComputerUsePatch(shadowedLookup); },
    /plugin lookup binding lookup does not resolve to the semantic declaration/u);
  assert.equal(unchanged, shadowedLookup);
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("signed unified owner patches idempotently with valid JavaScript", { skip: !signedApp }, () => {
  const directory = path.join(signedApp, ".vite", "build");
  const owners = fs.readdirSync(directory).filter(name => name.endsWith(".js")).map(name => ({
    name, source: fs.readFileSync(path.join(directory, name), "utf8"),
  })).filter(({ source }) => source.includes("cuaReplSurfaces:"));
  assert.equal(owners.length, 1);
  const patched = applyUnifiedComputerUsePatch(owners[0].source);
  assert.notEqual(patched, owners[0].source);
  assert.equal(applyUnifiedComputerUsePatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});
