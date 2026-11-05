"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { applyChronicleSkysightMainBridgePatch: apply, inspectChronicleBridge: inspect,
  recordReplayRuntimeHelperSource, chronicleSkysightBridgeHandlersSource, chronicleSkysightFetchHelperSource, descriptors } = require("./patch.js");

function methodBody(source, owner, name) {
  const body = source.slice(owner.open + 1, owner.end - 1);
  const head = one([...body.matchAll(new RegExp(`(?:async )?${escapeRegExp(name)}\\(([^)]*)\\)\\{`, "gu"))]);
  assert.ok(head, name);
  const open = owner.open + 1 + head.index + head[0].length - 1, end = findMatchingBrace(source, open);
  return { parameters: head[1], body: source.slice(open + 1, end) };
}
function one(values) { return values.length === 1 ? values[0] : null; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function nativeRuntime(original, patched, onCommand = null) {
  const before = inspect(original), plan = inspect(patched);
  assert.equal(before.state, "current"); assert.equal(plan.state, "patched");
  for (const role of ["controller", "service"]) {
    assert.equal(original.slice(before.native[role].start, before.native[role].end), patched.slice(plan.native[role].start, plan.native[role].end), `${role} native class is byte-identical`);
  }
  const calls = [], messages = [], cancelled = [], values = new Map();
  let state = "stopped";
  const profileState = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const sender = { sendInlineMessageForView(view, message) { assert.equal(this, sender); messages.push({ view, message }); } };
  const context = vm.createContext({ console, JSON, Promise, String, Error, AggregateError, an: { n: "inert-local-host" },
    process: { platform: "linux", env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/inert/never-executed" }, cwd: () => "/inert" },
    require(id) {
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      if (id === "node:child_process") return { execFile(binary, args, options, callback) {
        assert.equal(binary, "/inert/never-executed"); calls.push({ args: Array.from(args), options: plain(options) });
        const supplied = onCommand?.(Array.from(args));
        if (supplied) return callback(supplied.error ?? null, typeof supplied.stdout === "string" ? supplied.stdout : JSON.stringify(supplied.json), supplied.stderr ?? "");
        if (["start", "resume"].includes(args[1])) state = "running";
        else if (args[1] === "pause") state = "paused";
        else if (args[1] === "stop") state = "stopped";
        callback(null, JSON.stringify({ ok: true, schema_version: 1, state, is_running: state !== "stopped", paused: state === "paused" }), "");
      } };
      throw Error(`Unknown native harness dependency: ${id}`);
    },
  });
  const native = plan.native, controllerText = patched.slice(native.controller.start, native.controller.end);
  const cache = /cachedStatus=([A-Za-z_$][\w$]*);/u.exec(controllerText)[1];
  const prefix = patched.slice(plan.graph.scope.factoryStart, native.controller.start);
  const declaration = one([...prefix.matchAll(new RegExp(`(?:let|const|var) ${escapeRegExp(cache)}=\\{`, "gu"))]
    .filter(match => findMatchingBrace("{" + prefix.slice(0, match.index) + "}", 0) === match.index + 1));
  assert.ok(declaration, "native initial stopped state literal");
  const cacheOpen = declaration.index + declaration[0].length - 1, cacheEnd = findMatchingBrace(prefix, cacheOpen);
  context[cache] = vm.runInNewContext(`(${prefix.slice(cacheOpen, cacheEnd + 1)})`);
  const init = native.init;
  context[init.gate] = false;
  context[init.worker] = { requestComputerUseWorker() { throw Error("Unexpected macOS worker on Linux"); } };
  context[init.manager] = { reconcileComputerHistoryPluginInstallation() { throw Error("Unexpected Linux plugin migration"); } };
  context[init.archive] = () => { throw Error("Unexpected Linux archive migration"); };
  context[init.home] = { codexHome: "/inert" };
  context[init.cache] = { broadcastQueryCacheInvalidation() { throw Error("Unexpected Linux migration broadcast"); } };
  context[native.getter.feature] = () => ({ skysight: false });
  const helper = recordReplayRuntimeHelperSource({ childProcessVar: 'require("node:child_process")', fsVar: 'require("node:fs")', pathVar: 'require("node:path")' });
  const getter = patched.slice(native.getter.start, native.getter.end)
    .slice("getSkysightRecorderController:".length, -",artifactSessionHostLifecycle:".length);
  vm.runInContext(`${helper}\n${chronicleSkysightBridgeHandlersSource()}\n${chronicleSkysightFetchHelperSource()}\n${controllerText};let ${init.instance}=null;${patched.slice(init.start, init.end)};globalThis.controller=${init.instance};globalThis.getController=(${getter});`, context);
  assert.equal(context.getController(), context.controller); assert.equal(calls.length, 0);
  assert.equal(context.controller.desiredState, "stopped"); assert.equal(context.controller.shouldReconcileAfterServiceRespawn(), false);

  const site = plan.graph.wrapperRequest, owner = { open: patched.indexOf("{", site.ownerStart), end: site.ownerEnd };
  const response = methodBody(patched, owner, "handleDictationStreamConnectInfoRequest");
  const wrapper = { options: { chunkedMessageSender: sender },
    getAppServerConnection() { return { getBackendRequestAuth: async () => ({ routing: { kind: "personal" }, signal: { throwIfAborted() {} }, token: "inert-token" }) }; },
    getDictationStreamWebsocketUrl() { return "wss://inert.invalid"; }, cancelRequest(view, request) { cancelled.push({ receiver: this, view, request }); },
  };
  wrapper.handleRequest = vm.runInContext(`(async function(${site.webContentsVar},${site.requestVar}){${patched.slice(site.methodBodyStart, site.methodBodyEnd)}})`, context);
  wrapper.handleDictationStreamConnectInfoRequest = vm.runInContext(`(async function(${response.parameters}){${response.body}})`, context);
  const viewSite = plan.graph.viewFetch, viewOwner = { fetchWrapper: wrapper, globalState: profileState, chunkedMessageSender: sender };
  viewOwner.handleMessage = vm.runInContext(`(async function(${viewSite.webContentsVar},${viewSite.requestVar}){${patched.slice(viewSite.methodBodyStart, viewSite.methodBodyEnd)}})`, context);
  return { context, calls, messages, wrapper, viewOwner, cancelled, profileState, async request(method, body = "{}") {
    const view = { id: "actual-native-origin" }, request = { type: "fetch", requestId: `native-${messages.length}`, url: method.startsWith("/") || method.startsWith("https:") ? method : `vscode://codex/${method}`, body };
    await viewOwner.handleMessage(view, request);
    return { view, request, response: messages.at(-1)?.message };
  } };
}

for (const envName of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  test(`signed full-main production transaction and marker-free duplicate factory (${envName})`, { skip: process.env[envName] == null }, t => {
    const inventory = findMainProcessChunks(process.env[envName]); assert.ok(inventory);
    const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev"); fs.mkdirSync(cache, { recursive: true });
    const root = fs.mkdtempSync(path.join(cache, "chronicle-signed-main-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const build = path.join(root, ".vite/build"); fs.mkdirSync(build, { recursive: true });
    const originals = new Map();
    for (const name of inventory.chunks) { const bytes = fs.readFileSync(path.join(inventory.buildDir, name)); originals.set(name, bytes); fs.writeFileSync(path.join(build, name), bytes); }
    assert.equal(descriptors[0].phase, "extracted-app:pre-webview");
    const first = descriptors[0].apply(root); assert.equal(first.changed, 1); assert.equal(first.changedAssets.length, 1);
    const owner = first.changedAssets[0], output = fs.readFileSync(path.join(build, owner), "utf8"), plan = inspect(output);
    assert.equal(plan.state, "patched"); assert.equal(descriptors[0].apply(root).changed, 0);
    for (const [name, bytes] of originals) if (name !== owner) assert.ok(fs.readFileSync(path.join(build, name)).equals(bytes), name);
    const replica = `exports.ids=[999999],exports.modules={${JSON.stringify(plan.graph.scope.factoryId)}(){return false}};`;
    const replicaPath = path.join(build, "early-bootstrap-999999-a23a23.js"); fs.writeFileSync(replicaPath, replica);
    const reject = descriptors[0].apply(root); assert.equal(reject.changed, 0);
    assert.equal(fs.readFileSync(path.join(build, owner), "utf8"), output); assert.equal(fs.readFileSync(replicaPath, "utf8"), replica);
    fs.unlinkSync(replicaPath);
    const at = plan.graph.scope.factoryStart + (output.startsWith('"use strict";', plan.graph.scope.factoryStart) ? '"use strict";'.length : 0);
    const override = 'Object.assign(codexLinuxChronicleBridgeHandlers,{"chronicle-permissions":async()=>({spoof:true})});';
    const corrupted = output.slice(0, at) + override + output.slice(at);
    assert.doesNotThrow(() => new vm.Script(corrupted)); assert.equal(inspect(corrupted).state, "drifted");
    fs.writeFileSync(path.join(build, owner), corrupted);
    assert.equal(descriptors[0].apply(root).changed, 0); assert.equal(fs.readFileSync(path.join(build, owner), "utf8"), corrupted);
  });
  test(`actual native Chronicle init/getter/controller and request entry (${envName})`, { skip: process.env[envName] == null }, async () => {
    const inventory = findMainProcessChunks(process.env[envName]); assert.ok(inventory);
    const candidates = inventory.chunks.map(name => fs.readFileSync(path.join(inventory.buildDir, name), "utf8"))
      .filter(source => source.includes("skysight_gate_enabled") && source.includes("getSkysightRecorderController:"));
    const owners = candidates.filter(source => inspect(source).state === "current"); assert.equal(owners.length, 1);
    const original = owners[0], patched = apply(original); assert.notEqual(patched, original); assert.equal(apply(patched), patched);
    const run = nativeRuntime(original, patched);
    for (const method of ["chronicle-permissions", "getChronicleSidecarControlState", "linux-record-replay-skysight-status"]) {
      const result = await run.request(method); assert.equal(result.response.requestId, result.request.requestId);
      assert.equal(result.response.responseType, "success"); assert.equal(run.messages.at(-1).view, result.view);
    }
    assert.ok(run.calls.every(call => call.args.join(" ") === "skysight status"));
    assert.equal(run.context.controller.desiredState, "stopped");
    await run.context.controller.status(); await run.context.controller.enable(); await run.context.controller.pause();
    await run.context.controller.resume(); await run.context.controller.stop();
    assert.equal(run.context.controller.desiredState, "stopped");
    assert.ok(run.calls.some(call => call.args.join(" ") === "skysight start --source chronicle-desktop --owner manual-continuous --summary-agent enabled"));
    const before = run.calls.length;
    for (const request of [() => run.context.controller.getSettings(), () => run.context.controller.updateSettings({}), () => run.context.controller.clearHistory("all", "all")]) await assert.rejects(request(), /Unsupported Linux Chronicle method/);
    assert.equal(run.calls.length, before);
    const invalid = await run.request("linux-record-replay-skysight-start", "[]"); assert.equal(invalid.response.responseType, "error"); assert.equal(run.calls.length, before);
    const nativeReply = await run.request("/codex/dictation-stream-connect-info"); assert.equal(nativeReply.response.status, 200); assert.equal(nativeReply.response.requestId, nativeReply.request.requestId);
    await assert.rejects(run.request("https://example.invalid/"), /HTTP requests must use the HTTP fetch service/);
    const view = { id: "cancel-view" }, cancellation = { type: "cancel-fetch", requestId: "cancel" }; await run.viewOwner.handleMessage(view, cancellation);
    assert.equal(run.cancelled[0].receiver, run.wrapper); assert.equal(run.cancelled[0].view, view); assert.equal(run.cancelled[0].request, cancellation);
    assert.equal(run.profileState.get("untouched"), undefined);
  });
}
