"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const path = require("node:path");
const {applyNativeRuntimeEnvironmentPatch: patch} = require("./runtime-env");
const source = 'async function configure(e){let i="/plugin cache",a=p.default.join(i,`.mcp.json`),c={},l={};e.surfaces.includes(`browser`)&&(l.browser=`@oai/browser-desktop/service`),e.surfaces.includes(`computer`)&&(l.sky=`@oai/sky/service`),c.env={...e.nodeRepl?.env,CUA_REPL_NODE_REPL_PATH:e.nodeRepl?.command,CUA_REPL_ENABLED_SURFACES:e.surfaces.join(`,`),[n.Il]:JSON.stringify(l),[Wt]:e.browserBackends.join(`,`)},e.nodeRepl!=null&&(c.command=e.nodeRepl.env[n.jl],c.args=[p.default.join(e.nodeRepl.env[n.Al],`@oai/cua-repl/bin/cua-repl.mjs`)]);return c}';
test("app-managed CUA environment patch preserves upstream command and browser-only configuration", async () => {
  const patched = patch(source);
  assert.equal(patch(patched), patched);
  const configure = vm.runInNewContext(`(${patched})`, {process: {platform: "linux"}, p: {default: path}, n: {Il: "NODE_REPL_TRUSTED_SERVICES", jl: "NODE", Al: "MODULES"}, Wt: "BROWSERS"});
  const config = await configure({surfaces: ["browser"], browserBackends: ["iab"], nodeRepl: {command: "/runtime/repl", env: {NODE: "/runtime/node", MODULES: "/runtime/modules"}}});
  assert.deepEqual(Array.from(config.args), ["/runtime/modules/@oai/cua-repl/bin/cua-repl.mjs"]);
  assert.equal(config.command, "/runtime/node");
  assert.equal(config.env.NODE_REPL_JS_BANNER, undefined);
  assert.deepEqual(JSON.parse(config.env.NODE_REPL_TRUSTED_SERVICES), {browser: "@oai/browser-desktop/service"});
});
test("app-managed CUA patch fails closed on drift, ambiguity, and partial patches", () => {
  for (const broken of [source.replace("cua-repl.mjs", "changed.mjs"), source + source, source.replace("CUA_REPL_ENABLED_SURFACES", "CHANGED"), patch(source).replace("native-service.mjs", "changed.mjs")]) {
    assert.throws(() => patch(broken), /contract drift/);
  }
});

test("native surfaces receive scoped service and bootstrap paths, including paths with spaces", async (t) => {
  const fs = require("node:fs"), os = require("node:os");
  const {pathToFileURL} = require("node:url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cua-env-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const modulePath = path.join(dir, "configuration.mjs");
  fs.writeFileSync(modulePath, 'import path from "node:path"; const p={default:path}, n={Il:"NODE_REPL_TRUSTED_SERVICES",jl:"NODE",Al:"MODULES"}, Wt="BROWSERS";' + patch(source) + '\nexport default configure;');
  const {default: configure} = await import(pathToFileURL(modulePath).href);
  for (const surfaces of [["computer"], ["browser", "computer"]]) {
    const config = await configure({surfaces, browserBackends: [], nodeRepl: {command: "/runtime/repl", env: {NODE: "/runtime/node", MODULES: "/runtime modules"}}});
    const services = JSON.parse(config.env.NODE_REPL_TRUSTED_SERVICES);
    assert.equal(services.sky, "/plugin cache/scripts/native-service.mjs");
    assert.equal(services.browser, surfaces.includes("browser") ? "@oai/browser-desktop/service" : undefined);
    assert.equal(config.env.CUA_REPL_ENABLED_SURFACES, surfaces.join(","));
    assert.equal(config.env.NODE_REPL_TRUSTED_RPC_ENABLED, "1");
    assert.match(config.env.NODE_REPL_JS_BANNER, /file:\/\/\/plugin%20cache\/scripts\/native-launch\.mjs/);
    assert.match(config.env.NODE_REPL_JS_BANNER, /"factoryPath":"\/runtime modules\/@oai\/cua\//);
    assert.deepEqual(config.args, ["/runtime modules/@oai/cua-repl/bin/cua-repl.mjs"]);
  }
});

test("CUA matching tolerates minifier identifiers containing dollar signs", () => {
  const renamed = source.replace(/\be\b/g, () => "$options").replace(/\bc\b/g, () => "$config");
  const result = patch(renamed);
  assert.notEqual(result, renamed);
  assert.equal(patch(result), result);
});
