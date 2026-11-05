"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { currentChronicleMainFixture } = require("./fixtures/main-bridge.js");
const { applyChronicleSkysightMainBridgePatch, inspectChronicleBridge } = require("../chronicle-skysight/patch.js");
const { applyRecordReplayMainBridgePatch: apply, inspectRecordReplayMainBridge: inspect,
  recordReplayMainBridgeRegistration, recordReplayHelperSource, descriptors } = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");

function captureWarns(fn) {
  const warnings = [], original = console.warn; console.warn = (...args) => warnings.push(args.join(" "));
  try { return { value: fn(), warnings }; } finally { console.warn = original; }
}
function extractedFixture(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "record-replay-main-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".vite/build"), { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, ".vite/build", name), source);
  return root;
}
function productionBridge(root, enabled = ["record-and-replay"]) {
  const featuresConfigPath = path.join(root, "features.json");
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled, settings: {} }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath });
  const selected = normalizePatchDescriptors(loaded.filter(patch => patch.id === "feature:record-and-replay:linux-record-replay-main-bridge"));
  const report = createPatchReport(); report.enabledFeatures = [...new Set(loaded.map(patch => patch.featureId))];
  applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
  return report.patches.find(patch => patch.name === "feature:record-and-replay:linux-record-replay-main-bridge");
}
function unchanged(root, files) {
  for (const [name, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, ".vite/build", name), "utf8"), source, name);
}
function current() { return applyChronicleSkysightMainBridgePatch(currentChronicleMainFixture()); }

test("Record & Replay rejects orphan dependency runtime helpers in every main chunk", t => {
  for (const canonical of [false, true]) for (const suffix of ["Run", "String", "Bin", "Parse"]) {
    const source = canonical ? apply(current()) : current();
    const files = { "early-bootstrap.js": source,
      "early-bootstrap-904-aaaaaaaaaaaaaaaa.js": `function codexLinuxRecordReplay${suffix}(){}` };
    const root = extractedFixture(t, files);
    assert.equal(productionBridge(root).status, "skipped-optional");
    unchanged(root, files);
  }
});

// These tests use the production descriptor, not the pure source transformer.
test("Record & Replay registers one literal extension at the authoritative Chronicle slot", t => {
  const source = current(), before = inspectChronicleBridge(source), files = { "early-bootstrap.js": "const unrelated=true;", "early-bootstrap-45-abc.js": source };
  assert.equal(inspect(source).state, "current");
  const descriptor = descriptors.find(patch => patch.id === "linux-record-replay-main-bridge");
  assert.equal(descriptor.phase, "extracted-app:pre-webview"); assert.equal(descriptor.order, 152);
  const root = extractedFixture(t, files); assert.equal(productionBridge(root).status, "applied");
  const output = fs.readFileSync(path.join(root, ".vite/build/early-bootstrap-45-abc.js"), "utf8"), plan = inspect(output);
  assert.equal(plan.state, "patched"); assert.equal(plan.registration.start, before.registry.extensionAt);
  assert.equal(plan.extension.methods.length, 16); assert.equal(plan.dependency.registry.ownedMethods.length, 11);
  assert.equal(output.slice(0, plan.registration.start) + output.slice(plan.registration.end), source);
  assert.equal(productionBridge(root).status, "already-applied");
  assert.equal(fs.readFileSync(path.join(root, ".vite/build/early-bootstrap.js"), "utf8"), files["early-bootstrap.js"]);
  assert.equal(productionBridge(root, []), undefined);
});

test("Record & Replay rejects noncanonical, detached, shadowed and mutated main registrations without writing", t => {
  const source = current(), patched = apply(source), plan = inspect(patched), registration = recordReplayMainBridgeRegistration();
  assert.equal(plan.state, "patched");
  const helper = recordReplayHelperSource({ fsVar: 'require("node:fs")', pathVar: 'require("node:path")' });
  const call = patched.slice(plan.extension.start, plan.extension.end);
  const variants = {
    missingDependency: currentChronicleMainFixture(),
    fakeDependency: 'const text=' + JSON.stringify(source) + ';',
    helperOnly: helper + source,
    registrationOnly: registration + currentChronicleMainFixture(),
    missingAction: patched.replace('"linux-record-replay-status":async', '"linux-record-replay-status-broken":async'),
    changedActionArgs: patched.replace('["record","stop","--session-dir",t]', '["record","cancel","--session-dir",t]'),
    changedRequire: patched.replace('require("node:fs").openSync', 'require("fs").openSync'),
    wrongAssignmentTarget: patched.replace(call, call.replace('Object.assign(codexLinuxChronicleBridgeHandlers,', 'Object.assign(otherHandlers,')),
    wrappedHelper: patched.replace(helper, 'function unused(){' + helper + '}'),
    stringHelper: patched.replace(helper, 'const unused=' + JSON.stringify(helper) + ';'),
    wrappedAssignment: patched.replace(call, 'function unused(){' + call + '}'),
    stringAssignment: patched.replace(call, 'const unused=' + JSON.stringify(call) + ';'),
    movedRegistration: patched.replace(registration, '') + registration,
    duplicatedRegistration: patched + registration,
    missingEndMarker: patched.replace('/*codex-linux-record-replay-bridge-end*/', ''),
    helperReassignment: patched + ';codexLinuxRecordReplayWriteTempJson=()=>"/foreign";',
    helperUpdate: patched + ';codexLinuxRecordReplayActiveSessionDir++;',
    helperAlias: patched + ';const alias=codexLinuxRecordReplayWriteTempJson;',
    helperShadow: patched.replace('class RequestWrapper{', 'function codexLinuxRecordReplayActiveSessionDir(){return "/foreign"}class RequestWrapper{'),
    factoryOverride: patched.replace('class RequestWrapper{', 'Object.assign(codexLinuxChronicleBridgeHandlers,{"linux-record-replay-stop":async()=>({ok:true})});class RequestWrapper{'),
    dateShadow: 'const Date={now:()=>0};' + patched,
    mathWrite: patched + ';Math={random:()=>0};',
    mathPatternWrite: patched + ';({Math}={Math:{random:()=>0}});',
    datePatternWrite: patched + ';[Date]=[{now:()=>0}];',
    escapedTempWrite: patched + String.raw`;codexLinuxRecordReplayWriteTempJso\u006e=()=>"/foreign";`,
    escapedActiveWrite: patched + String.raw`;codexLinuxRecordReplayActiveSessionDi\u0072=()=>"/foreign";`,
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(variant, patched, name); assert.doesNotThrow(() => new vm.Script(variant), name);
    assert.equal(inspect(variant).state, "drifted", name);
    const files = { "early-bootstrap-45-abc.js": variant }, root = extractedFixture(t, files);
    const result = captureWarns(() => productionBridge(root));
    assert.equal(result.value.status, "skipped-optional", name); assert.ok(result.warnings.length, name); unchanged(root, files);
  }
});

for (const scenario of ["missing", "duplicate", "mixed", "same-id-no-needles", "same-id-exponent", "same-id-quoted", "orphan-own-helper", "orphan-own-action", "orphan-own-single-quoted-action", "orphan-own-escaped-helper", "orphan-dependency", "partial"]) {
  test(`Record & Replay production descriptor rejects ${scenario} cohort without writing`, t => {
    const source = current(), patched = apply(source);
    const files = scenario === "missing" ? { "early-bootstrap.js": "const unrelated=true;" } : { "early-bootstrap-45-abc.js": source };
    if (scenario === "duplicate") files["early-bootstrap-46-def.js"] = source;
    if (scenario === "mixed") files["early-bootstrap-46-def.js"] = patched;
    if (scenario.startsWith("same-id")) files["early-bootstrap-46-def.js"] = `exports.ids=[46],exports.modules={${scenario === "same-id-exponent" ? "8.282e4" : scenario === "same-id-quoted" ? '"82820"' : "82820"}(){return false}};`;
    if (scenario === "orphan-own-helper") files["early-bootstrap-46-def.js"] = 'const fragment="codexLinuxRecordReplayActiveSessionDir";';
    if (scenario === "orphan-own-action") files["early-bootstrap-46-def.js"] = 'const fragment="linux-record-replay-browser-trace";';
    if (scenario === "orphan-own-single-quoted-action") files["early-bootstrap-46-def.js"] = "const fragment='linux-record-replay-browser-trace';";
    if (scenario === "orphan-own-escaped-helper") files["early-bootstrap-46-def.js"] = String.raw`function codexLinuxRecordReplayWriteTempJso\u006e(){}`;
    if (scenario === "orphan-dependency") files["early-bootstrap-46-def.js"] = 'const fragment="codexLinuxChronicleFetch";';
    if (scenario === "partial") files["early-bootstrap-45-abc.js"] = patched.replace('"linux-record-replay-status":async', '"linux-record-replay-status-broken":async');
    const root = extractedFixture(t, files), result = captureWarns(() => productionBridge(root));
    assert.equal(result.value.status, "skipped-optional"); assert.ok(result.warnings.length); unchanged(root, files);
  });
}

test("Record & Replay transaction restores source after partial writes and treats unverifiable rollback as fatal", t => {
  for (const fatal of [false, true]) {
    const source = current(), files = { "early-bootstrap-45-abc.js": source }, root = extractedFixture(t, files);
    const target = path.join(root, ".vite/build/early-bootstrap-45-abc.js"), write = fs.writeFileSync;
    let attempted = false;
    fs.writeFileSync = (file, content, ...options) => {
      if (file === target) {
        if (!attempted) { attempted = true; write(file, "partial"); throw Error("inert write failure"); }
        if (fatal) throw Error("inert restore failure");
      }
      return write(file, content, ...options);
    };
    try {
      if (fatal) assert.throws(() => captureWarns(() => productionBridge(root)), /rollback could not restore original bytes/);
      else assert.equal(captureWarns(() => productionBridge(root)).value.status, "skipped-optional");
    } finally { fs.writeFileSync = write; }
    assert.equal(attempted, true); if (!fatal) unchanged(root, files);
  }
});

function nativeRuntime(source, onCommand, runtimeDir) {
  const plan = inspect(source); assert.equal(plan.state, "patched");
  const calls = [], messages = [], context = vm.createContext({ console, JSON, Promise, String, Error,
    process: { platform: "linux", env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/inert/never-executed", TMPDIR: runtimeDir }, cwd: () => "/inert", pid: 7301 },
    require(id) {
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      if (id === "node:child_process") return { execFile(binary, args, options, callback) {
        assert.equal(binary, "/inert/never-executed"); calls.push({ args: Array.from(args), options: JSON.parse(JSON.stringify(options)) });
        const result = onCommand(Array.from(args));
        callback(result.error ?? null, typeof result.stdout === "string" ? result.stdout : JSON.stringify(result.json), result.stderr ?? "");
      } };
      throw Error(`Unexpected import ${id}`);
    },
  });
  const base = plan.dependency;
  vm.runInContext(base.helpers.map(span => source.slice(span.start, span.end)).join("\n") + source.slice(plan.registration.start, plan.registration.end), context);
  const sender = { sendInlineMessageForView(view, message) { assert.equal(this, sender); messages.push({ view, message }); } };
  const site = plan.graph.wrapperRequest;
  const wrapper = { options: { chunkedMessageSender: sender } };
  wrapper.handleRequest = vm.runInContext(`(async function(${site.webContentsVar},${site.requestVar}){${source.slice(site.methodBodyStart, site.methodBodyEnd)}})`, context);
  const viewSite = plan.graph.viewFetch, viewed = { fetchWrapper: wrapper, globalState: {}, chunkedMessageSender: sender };
  viewed.handleMessage = vm.runInContext(`(async function(${viewSite.webContentsVar},${viewSite.requestVar}){${source.slice(viewSite.methodBodyStart, viewSite.methodBodyEnd)}})`, context);
  return { calls, messages, async request(method, params = {}) {
    const view = { id: "inert-native-view" }, request = { type: "fetch", requestId: "native-" + messages.length, url: "vscode://codex/" + method, body: JSON.stringify(params) };
    await viewed.handleMessage(view, request);
    const result = messages.at(-1); assert.equal(result.view, view); assert.equal(result.message.requestId, request.requestId);
    return result.message.responseType === "success" ? JSON.parse(result.message.bodyJsonString) : result.message;
  } };
}

for (const envName of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  test(`signed full-main production transaction and native lifecycle (${envName})`, { skip: process.env[envName] == null }, async t => {
    const inventory = findMainProcessChunks(process.env[envName]); assert.ok(inventory);
    const files = Object.fromEntries(inventory.chunks.map(name => [name, fs.readFileSync(path.join(inventory.buildDir, name), "utf8")]));
    const root = extractedFixture(t, files), chronicle = require("../chronicle-skysight/patch.js").descriptors[0];
    const firstDependency = chronicle.apply(root); assert.equal(firstDependency.changed, 1);
    const before = Object.fromEntries(inventory.chunks.map(name => [name, fs.readFileSync(path.join(root, ".vite/build", name), "utf8")]));
    const first = productionBridge(root); assert.equal(first.status, "applied");
    const changed = inventory.chunks.filter(name => fs.readFileSync(path.join(root, ".vite/build", name), "utf8") !== before[name]); assert.equal(changed.length, 1);
    const owner = changed[0], output = fs.readFileSync(path.join(root, ".vite/build", owner), "utf8"), plan = inspect(output);
    assert.equal(plan.state, "patched"); assert.equal(productionBridge(root).status, "already-applied");
    for (const [name, original] of Object.entries(before)) if (name !== owner) assert.equal(fs.readFileSync(path.join(root, ".vite/build", name), "utf8"), original, name);
    const copyPath = path.join(root, ".vite/build/early-bootstrap-999999-a23a23.js"), copy = `exports.ids=[999999],exports.modules={${JSON.stringify(plan.graph.scope.factoryId)}(){return false}};`;
    fs.writeFileSync(copyPath, copy); assert.equal(captureWarns(() => productionBridge(root)).value.status, "skipped-optional");
    assert.equal(fs.readFileSync(path.join(root, ".vite/build", owner), "utf8"), output); fs.unlinkSync(copyPath);

    // A bounded collaborator models the Rust command/state boundary; no binary,
    // capture provider, model, profile, or real session is opened by this test.
    const sessions = new Map(), evidence = []; let active = null;
    const onCommand = args => {
      if (args[0] === "status") return { json: { ok: true, state: active ? "active" : "idle", session_dir: active } };
      if (args[0] === "skysight") return { json: { ok: true, state: "stopped", is_running: false } };
      if (args[0] === "bundle") return { json: { ok: args[1] !== "validate", action: args[1], errors: ["fixture-only validation"] } };
      if (args[0] === "skill") return { json: { ok: args[1] !== "inspect", action: args[1] } };
      assert.equal(args[0], "record"); const session = args[args.indexOf("--session-dir") + 1], operation = args[1];
      if (operation === "start") {
        if (sessions.has(session)) return { error: Object.assign(Error("session exists"), { code: 1 }), json: { ok: false, error: "session exists" } };
        sessions.set(session, "active"); active = session;
      } else if (sessions.get(session) !== "active") return { error: Object.assign(Error("sealed session"), { code: 1 }), json: { ok: false, error: "sealed session" } };
      else if (["stop", "cancel"].includes(operation)) { sessions.set(session, operation === "stop" ? "stopped" : "canceled"); active = null; }
      else {
        if (operation === "browser-trace") {
          const trace = args[args.indexOf("--trace-file") + 1]; assert.deepEqual(JSON.parse(fs.readFileSync(trace, "utf8")), { owned: true });
          assert.equal(fs.statSync(trace).mode & 0o777, 0o600); evidence.push({ operation, trace });
        } else evidence.push({ operation, session });
      }
      return { json: { ok: true, state: sessions.get(session), session_dir: session, discarded: args.includes("--discarded") } };
    };
    const run = nativeRuntime(output, onCommand, root);
    assert.equal(run.calls.length, 0);
    const request = (method, params) => run.request("linux-record-replay-" + method, params);
    assert.equal((await request("start", { sessionDir: "/inert/session-a" })).json.state, "active");
    assert.equal((await request("start", { sessionDir: "/inert/session-a" })).ok, false);
    assert.equal((await request("status")).json.state, "active");
    for (const [method, params] of [["mark", { note: "marker" }], ["speech-context-active", { transcript: "speech" }], ["browser-trace", { trace: { owned: true } }], ["desktop-snapshot", { source: "fixture" }]]) assert.equal((await request(method, { sessionDir: "/inert/session-a", ...params })).ok, true);
    assert.equal((await request("stop-active")).json.state, "stopped");
    assert.equal((await request("stop", { sessionDir: "/inert/session-a" })).ok, false);
    assert.equal((await request("cancel", { sessionDir: "/inert/session-a" })).ok, false);
    assert.equal((await request("mark", { sessionDir: "/inert/session-a", note: "late" })).ok, false);
    for (const discarded of [false, true]) {
      const sessionDir = "/inert/cancel-" + discarded; await request("start", { sessionDir });
      const result = await request("cancel-active", { discarded }); assert.equal(result.json.state, "canceled"); assert.equal(result.json.discarded, discarded);
      assert.equal((await request("cancel", { sessionDir })).ok, false);
    }
    const prior = run.calls.length; assert.equal((await request("stop-active")).ok, false); assert.equal(run.calls.length, prior + 1);
    assert.equal((await request("bundle", { bundle: "/inert/bundle" })).json.ok, false);
    assert.equal((await request("draft-skill", { bundle: "/inert/bundle" })).ok, true);
    assert.equal((await request("import-skill", { source: "/inert/skill", dryRun: true })).ok, true);
    assert.equal((await request("inspect-skill", { source: "/inert/skill" })).json.ok, false);
    assert.deepEqual(evidence.map(item => item.operation), ["mark", "speech", "browser-trace", "desktop-snapshot"]);
    for (const item of evidence) if (item.trace) assert.equal(fs.existsSync(item.trace), false);
    assert.equal(run.calls.some(call => call.args[0] === "skysight"), false);
    assert.equal((await run.request("linux-record-replay-skysight-status")).json.state, "stopped");
  });
}
