"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

const fixture = [
  'function build({browserBackends:b,deferTools:d,confirmationPolicyConfig:c="{}",omitCuaConfirmationPolicyBySku:q,surfaces:s,nodeRepl:n,sharedPlugin:a=!1}){',
  'let o={};s.includes("browser")&&(o.browser="@oai/browser-desktop/service"),s.includes("computer")&&(o.sky="@oai/sky/service");',
  'let env={CUA_REPL_ENABLED_SURFACES:s.join(","),[keys.services]:JSON.stringify(o)};',
  'function packaged(e){return{NODE_REPL_TRUSTED_SERVICES:e.NODE_REPL_TRUSTED_SERVICES??JSON.stringify(o),NODE_REPL_JS_BANNER:e.NODE_REPL_JS_BANNER??banner}}',
  'return{env}}',
  'async function synchronize(root,e){}',
  'async function initialize(e){let f=await select(),{codexHome:w,marketplaceName:y,runtimePaths:z,browserBackends:v,cuaReplSurfaces:S}=f;',
  'let t={browserBackends:v,deferTools:true,confirmationPolicyConfig:"{}",omitCuaConfirmationPolicyBySku:false,surfaces:S,nodeRepl:{}};',
  'let g=[],x=await async function(e){let p={plugin:{installed:true,localVersion:"v"},marketplace:{name:"m"}};',
  'let r=(0,plugins.root)({codexHome:e.codexHome,localVersion:p.plugin.localVersion,marketplaceName:p.marketplace.name,pluginName:p.plugin.name});',
  'return await synchronize(r,e)}({...t,codexHome:w,marketplaceName:y,marketplaces:g});',
  'let C=true,I="{}";return await e.sendAppServerRequest("config/batchWrite",{edits:[],expectedVersion:null}),{selection:f,cuaReplEnabled:C,executorLaunch:x,confirmationPolicyConfig:I}}',
  'async function thread({appServerConnection:e,appVersion:t,selection:r,verifyBrowserService:n=!1,includePrivateProcessEnv:i=!0,hostServicesPipePath:h=null}){',
  'let{codexHome:a,marketplaceName:o,browserServicePluginVersion:l,desktopFeatureAvailability:c,runtimePaths:d,shouldUseWslPaths:u,browserBackends:b,computerUse:p,computerUsePaths:m}=r;',
  'let v="/browser",q={env:{[keys.services]:null!=v||p?JSON.stringify({...null==v?{}:{browser:v},...p?{sky:"@oai/sky/service"}:{}}):void 0}},y={"mcp_servers.node_repl":q};',
  'if(null==y)return null;return y}',
  'async function resume(){let s={cuaReplEnabled:true},o=s?.selection??await select(),c={};',
  'return build({browserBackends:o.browserBackends,deferTools:o.desktopFeatureAvailability.deferCuaTools,confirmationPolicyConfig:s.confirmationPolicyConfig,omitCuaConfirmationPolicyBySku:o.desktopFeatureAvailability.omitCuaConfirmationPolicyBySku,surfaces:o.cuaReplSurfaces,nodeRepl:c})}',
  'async function selection(){let u=true,t={computerUse:true,browserUseTinysky:true},c={enabled:true,paths:{serviceAppPath:null}},o={platform:"linux"},h=u&&t.computerUse&&c.enabled&&("win32"===o.platform||"darwin"===o.platform&&null!=c.paths.serviceAppPath),p=t.computerUse&&(!t.browserUseTinysky||"darwin"!==o.platform||c.enabled),m=[];return{cuaReplSurfaces:m}}',
].join("");

test("current unified contract enables Linux and propagates the verified plugin root", () => {
  const patched = applyUnifiedComputerUsePatch(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(applyUnifiedComputerUsePatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.match(patched, /"linux"===o\.platform\?h:/u);
  assert.equal(patched.split("codexLinuxUnifiedCuaBuilder").length, 2);
  assert.equal(patched.split("codexLinuxUnifiedCuaRoot").length, 2);
  assert.equal(patched.split("codexLinuxUnifiedCuaThread").length, 2);
  assert.match(patched, /require\("node:path"\)\.join\(codexLinuxCuaPluginRoot,"scripts","native-service\.mjs"\)/u);
  assert.match(patched, /codexLinuxCuaContext:f/u);
  assert.match(patched, /codexLinuxCuaPluginRoot:o\.codexLinuxCuaPluginRoot/u);
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
