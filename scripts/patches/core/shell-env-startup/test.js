"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { DEFER, applyShellEnvironmentStartup, matchesShellEnvironment } = require("./shell-env.js");
const { descriptors, patchShellEnvironmentStartup } = require("./patch.js");
const { SHELL_ENVIRONMENT_FIXTURE: FIXTURE, startupFunctions } = require("./test-helpers.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../engine.js");
const { createPatchReport } = require("../../../lib/patch-report.js");

function appFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-core-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite/build");
  fs.mkdirSync(build, { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(build, name), source);
  return root;
}
function applyRequired(root) {
  const report = createPatchReport();
  applyExtractedAppPatchDescriptors(root, normalizePatchDescriptors(descriptors), {}, report, "extracted-app:pre-webview");
  return report.patches[0];
}
function unchanged(root, files) {
  for (const [name, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, ".vite/build", name), "utf8"), source, name);
}

// Only the actual named request/startup declarations are evaluated. The vendor
// factory and imports remain unexecuted, with explicit inert globals per role.
function runtime(source, { platform = "linux", spawn } = {}) {
  const functions = startupFunctions(source), body = functions.requestText;
  const name = (pattern, role) => {
    const match = pattern.exec(body);
    assert.ok(match, role);
    return match[1];
  };
  const callbacks = [], spawns = [], warnings = [], timers = [], cleared = [];
  const context = {
    process: { platform, env: { PATH: "/initial/bin" } }, AbortController,
    setImmediate: callback => callbacks.push(callback),
    setTimeout: (callback, timeout) => { const timer = { callback, timeout, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => cleared.push(timer),
  };
  const electron = name(/([\w$]+)\.app\.isPackaged/u, "Electron alias");
  const shell = name(/\(0,([\w$]+)\.MN\)/u, "shell spawn import");
  const cache = name(/if\(([\w$]+)\?\.status/u, "cache binding");
  const pending = /if\(null!=([\w$]+)&&null!=([\w$]+)/u.exec(body);
  assert.ok(pending);
  context[electron] = { app: { isPackaged: true } };
  context[shell] = { $z: "INERT_SHELL_MARKER", getLogger: () => ({ warning: (...args) => warnings.push(args) }),
    MN: options => { spawns.push(options); return spawn ? spawn(options) : Promise.resolve({ PATH: "/loaded/bin" }); } };
  context[cache] = null;
  context[pending[1]] = null;
  context[pending[2]] = null;
  context[name(/null!=([\w$]+)&&\(process\.env\.CODEX_HOME/u, "preserved home")] = undefined;
  context[name(/([\w$]+)\.forEach\(/u, "environment listeners")] = new Set();
  context[name(/pathEntryCount:([\w$]+)\(/u, "path counter")] = value => value.split(":").length;
  context[name(/\.\.\.([\w$]+)\(/u, "load metadata")] = () => ({ resultSource: "load" });
  const startup = vm.runInNewContext(`${functions.requestText}\n${functions.startupText}\n${functions.startupName}`, context);
  return { startup, callbacks, spawns, warnings, timers, cleared, context };
}

async function assertDeferral(source) {
  const r = runtime(applyShellEnvironmentStartup(source));
  const result = r.startup();
  await Promise.resolve();
  assert.equal(r.spawns.length, 0);
  assert.equal(r.callbacks.length, 1);
  r.callbacks.shift()();
  assert.equal((await result).status, "loaded");
  assert.equal(r.spawns.length, 1);
  assert.equal(r.spawns[0].interactive, true);
  assert.equal(r.timers[0].timeout, 5000);
  assert.equal(r.cleared[0], r.timers[0]);
}

test("one standalone required shell descriptor replaces the retired compound repair", () => {
  assert.deepEqual(descriptors.map(({ id, ciPolicy, phase }) => ({ id, ciPolicy, phase })), [{
    id: "shell-env-startup", ciPolicy: "required-upstream", phase: "extracted-app:pre-webview",
  }]);
});

test("Linux actual request/startup function fragments defer shell spawn one whole turn", async () => {
  await assertDeferral(FIXTURE);
});

test("the whole-turn defer preserves completion across the modeled browser reset", async () => {
  async function completed(source) {
    let childExit = () => {}, settled = false;
    const r = runtime(source, { spawn: () => new Promise(resolve => { childExit = () => resolve({ PATH: "/loaded/bin" }); }) });
    r.startup().then(() => { settled = true; });
    await Promise.resolve();
    childExit = () => {};
    for (const callback of r.callbacks) callback();
    await Promise.resolve();
    childExit();
    await new Promise(setImmediate);
    return settled;
  }
  assert.equal(await completed(FIXTURE), false);
  assert.equal(await completed(applyShellEnvironmentStartup(FIXTURE)), true);
});

test("other platforms retain synchronous spawn and the native failure result", async () => {
  const r = runtime(applyShellEnvironmentStartup(FIXTURE), { platform: "darwin", spawn: () => Promise.reject(new Error("shell unavailable")) });
  const result = r.startup();
  assert.equal(r.spawns.length, 1);
  assert.equal(r.callbacks.length, 0);
  assert.equal((await result).status, "failed");
  assert.equal(r.warnings.length, 1);
});

test("anonymous loader patch is exact, idempotent and rejects disconnected or partial contracts", () => {
  const patched = applyShellEnvironmentStartup(FIXTURE);
  assert.equal(patched.replace(DEFER, ""), FIXTURE);
  assert.equal(applyShellEnvironmentStartup(patched), patched);
  for (const broken of [
    FIXTURE.replace("Date.now()", "performance.now()"),
    FIXTURE.replace("}(caller,timeout);", "}(caller,42);"),
    FIXTURE.replace("startup:()=>startup", "startup:()=>unrelated"),
    FIXTURE.replace("pending=result,pendingTimeout=timeout", "pending=other,pendingTimeout=timeout"),
    FIXTURE.replace("async function(caller,timeout)", "async function legacy(caller,timeout)"),
    FIXTURE.replace('let result=async function', 'return;let result=async function'),
    patched.replace("new Promise(setImmediate)", "Promise.resolve()"),
    DEFER + FIXTURE,
  ]) assert.throws(() => applyShellEnvironmentStartup(broken));
});

test("published request/startup owners are declarations with stable factory bindings", t => {
  const functions = startupFunctions(FIXTURE);
  const variants = [
    FIXTURE.replace(functions.requestText, `const unusedRequest=${functions.requestText};`),
    FIXTURE.replace(functions.startupText, `const unusedStartup=${functions.startupText};`),
    FIXTURE.replace(/\}\};$/u, 'request=async()=>({status:"loaded"});}};'),
    FIXTURE.replace(/\}\};$/u, 'request&&=async()=>({status:"loaded"});}};'),
    FIXTURE.replace(/\}\};$/u, '[request]=[async()=>({status:"loaded"})];}};'),
    FIXTURE.replace(/\}\};$/u, 'request++;}};'),
    FIXTURE.replace(/\}\};$/u, String.raw`\u0072equest=async()=>({status:"loaded"});}};`),
    FIXTURE.replace('r.d(t,{', 'r={d(){}};r.d(t,{'),
    FIXTURE.replace('r.d(t,{', 't={};r.d(t,{'),
    FIXTURE.replace('r.d(t,{', 'r.d=()=>{};r.d(t,{'),
    FIXTURE.replace(/\}\};$/u, 'function r(){} }};'),
    FIXTURE.replace(/\}\};$/u, 'function t(){} }};'),
    FIXTURE.replace(/\}\};$/u, String.raw`function \u0072(){} }};`),
  ];
  for (const source of variants) {
    assert.notEqual(source, FIXTURE);
    new vm.Script(source);
    assert.throws(() => applyShellEnvironmentStartup(source));
    const files = { "early-bootstrap-133-abcd.js": source }, root = appFixture(t, files);
    assert.equal(applyRequired(root).status, "failed-required");
    unchanged(root, files);
  }
});

test("required descriptor validates inventory and transacts before reporting success", t => {
  const files = { "early-bootstrap-133-abcd.js": FIXTURE, "early-bootstrap.js": "const entry=true;" };
  const root = appFixture(t, files);
  assert.equal(applyRequired(root).status, "applied");
  assert.equal(applyRequired(root).status, "already-applied");
  assert.equal(fs.readFileSync(path.join(root, ".vite/build/early-bootstrap.js"), "utf8"), files["early-bootstrap.js"]);
});

for (const kind of ["missing", "duplicate", "damaged-same-id", "scientific-same-id", "quoted-same-id", "hex-same-id", "partial-marker", "invalid-source"]) {
  test(`required descriptor refuses ${kind} inventory with zero writes`, t => {
    const files = { "early-bootstrap-133-abcd.js": kind === "missing" ? "const entry=true;" : FIXTURE };
    if (kind === "duplicate") files["early-bootstrap-134-abcd.js"] = FIXTURE;
    if (kind === "damaged-same-id") files["early-bootstrap-134-abcd.js"] = 'exports.ids=[134],exports.modules={66439(e,t,r){return false}};';
    if (["scientific-same-id", "quoted-same-id", "hex-same-id"].includes(kind)) {
      const key = kind === "scientific-same-id" ? "6.6439e4" : kind === "quoted-same-id" ? '"66439"' : "0x10387";
      files["early-bootstrap-134-abcd.js"] = `"use strict";exports.ids=[134],exports.modules={${key}(e,t,r){return false}};`;
    }
    if (kind === "partial-marker") files["early-bootstrap-134-abcd.js"] = '/* codex-linux-shell-env-startup */const unrelated=true;';
    if (kind === "invalid-source") files["early-bootstrap-133-abcd.js"] += "{";
    const root = appFixture(t, files);
    assert.equal(applyRequired(root).status, "failed-required");
    unchanged(root, files);
  });
}

test("partial writes roll back and unverifiable restoration remains fatal", t => {
  for (const fatal of [false, true]) {
    const files = { "early-bootstrap-133-abcd.js": FIXTURE }, root = appFixture(t, files);
    const target = path.join(root, ".vite/build/early-bootstrap-133-abcd.js"), original = fs.writeFileSync;
    let attempted = false;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (file === target) {
        if (!attempted) { attempted = true; original(file, "partial-write"); throw Error("inert write failure"); }
        if (fatal) throw Error("inert restore failure");
      }
      return original(file, bytes, ...options);
    };
    try {
      if (fatal) assert.throws(() => applyRequired(root), /rollback could not restore original bytes/u);
      else assert.equal(applyRequired(root).status, "failed-required");
    } finally { fs.writeFileSync = original; }
    assert.equal(attempted, true);
    if (!fatal) unchanged(root, files);
  }
});

test("latest signed shell module applies through the required descriptor and actual startup fragments", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, async t => {
  const dir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite/build");
  const sources = fs.readdirSync(dir).filter(name => /^early-bootstrap.*\.js$/u.test(name))
    .map(name => ({ name, source: fs.readFileSync(path.join(dir, name), "utf8") }))
    .filter(({ source }) => matchesShellEnvironment(source));
  assert.equal(sources.length, 1);
  const [{ name, source }] = sources, patched = applyShellEnvironmentStartup(source);
  assert.equal(patched.replace(DEFER, ""), source);
  assert.equal(applyShellEnvironmentStartup(patched), patched);
  await assertDeferral(source);
  const functions = startupFunctions(source);
  const { mainProcessFactories } = require("../../lib/main-process-factories.js");
  const owner = mainProcessFactories(source).find(module => matchesShellEnvironment(module.body));
  const publication = `${owner.parameters[2]}.d(${owner.parameters[1]},{`;
  const publicationIndex = owner.start + owner.body.indexOf(publication);
  const prependPublication = text => source.slice(0, publicationIndex) + text + source.slice(publicationIndex);
  for (const variant of [
    source.replace(functions.requestText, `const unusedShellRequest=${functions.requestText};`),
    source.replace(functions.startupText, `const unusedShellStartup=${functions.startupText};`),
    source.replace(functions.startupText, functions.startupText+`${functions.requestName}=async()=>({status:"loaded"});`),
    source.replace(functions.startupText, functions.startupText+`${functions.startupName}=async()=>({status:"loaded"});`),
    prependPublication(`${owner.parameters[2]}={d(){}};`),
    prependPublication(`${owner.parameters[1]}={};`),
    source.replace(functions.startupText, functions.startupText+`function ${owner.parameters[2]}(){}`),
    source.replace(functions.startupText, functions.startupText+`function ${owner.parameters[1]}(){}`),
  ]) {
    assert.notEqual(variant, source);
    new vm.Script(variant);
    assert.throws(() => applyShellEnvironmentStartup(variant));
    const files = { [name]: variant, "early-bootstrap.js": "const inertEntry=true;" }, refusal = appFixture(t, files);
    assert.equal(applyRequired(refusal).status, "failed-required");
    unchanged(refusal, files);
  }
  const root = appFixture(t, { [name]: source, "early-bootstrap.js": "const inertEntry=true;" });
  assert.equal(applyRequired(root).status, "applied");
  assert.equal(applyRequired(root).status, "already-applied");
});
