"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { fixture } = require("../../scripts/patches/lib/fixtures/main-request-graph.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");
const { applyExtractedAppPatchDescriptors, normalizeDescriptor } = require("../../scripts/patches/engine.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyMainBundlePatch, applyMainToExtractedApp, descriptors } = require("./patch.js");
const descriptor = normalizeDescriptor({ ...descriptors.find(({ id }) => id === "main-handler"),
  id: "feature:read-aloud:main-handler", featureId: "read-aloud" });
const START = "/*codex-linux-read-aloud-helpers-start*/", END = "/*codex-linux-read-aloud-helpers-end*/\n";
const tick = () => new Promise(resolve => setImmediate(resolve));

function normal(input) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "read-aloud-descriptor-")), build = path.join(root, ".vite/build");
  const files = typeof input === "string" ? { "early-bootstrap.js": input } : input;
  fs.mkdirSync(build, { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(build, name), source);
  const report = createPatchReport(), warn = console.warn; console.warn = () => {};
  try {
    applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, descriptor.phase);
    const output = Object.fromEntries(Object.keys(files).map(name => [name, fs.readFileSync(path.join(build, name), "utf8")]));
    return { source: output[Object.keys(files)[0]], files: output, patch: report.patches[0] };
  } finally { console.warn = warn; fs.rmSync(root, { recursive: true, force: true }); }
}

function ownedRoot(t) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "read-aloud-main-handler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function harness(t, { source = fixture(), env = {}, manual = false, spawnError = false, io = fs } = {}) {
  const root = ownedRoot(t), custom = path.join(root, "custom-voice"), model = path.join(root, "model");
  fs.writeFileSync(custom, "fixture; never executed", { mode: 0o755 }); fs.writeFileSync(model, "fixture");
  const children = [], killed = [], sent = [], logs = [], app = new EventEmitter(), proc = new EventEmitter();
  Object.assign(proc, { platform: "linux", pid: 7000, resourcesPath: path.join(root, "resources"),
    env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK: "0", ...env },
    kill: (pid, signal) => { killed.push([pid, signal]); } });
  const cp = { spawnSync: () => ({ status: 1 }), spawn(command, args, options) {
    const child = new EventEmitter(); child.pid = 30000 + children.length;
    child.stdin = new EventEmitter(); child.stdin.end = text => { child.input = text; };
    child.stdout = new EventEmitter(); child.stdout.pipe = sink => { child.sink = sink; };
    child.kill = signal => killed.push([child.pid, signal]); child.unref = () => {};
    children.push({ command, args, options, child });
    if (!manual) queueMicrotask(() => child.emit(spawnError ? "error" : "spawn", Error("fixture launch failure")));
    return child;
  } };
  const requireStub = name => {
    if (name === "node:child_process") return cp;
    if (name === "node:fs") return io;
    if (name === "node:path") return path;
    if (name === "node:os") return { homedir: () => root };
    if (name === "electron") return { app, dialog: { showOpenDialog: async () => ({ canceled: true }) } };
    throw Error("Unapproved fixture import: " + name);
  };
  const result = normal(source); assert.equal(result.patch.status, "applied");
  const context = vm.createContext({ require: requireStub, process: proc, exports: {},
    console: { info: (...args) => logs.push(args) }, setTimeout, clearTimeout, URL, Symbol, Map, Set, Promise, Error, AbortController });
  // Evaluating the carrier defines its factories; it never runs the official
  // module, startup, constructors, imports, application or desktop helpers.
  vm.runInContext(result.source, context);
  const api = vm.runInContext('({handle:codexLinuxReadAloudHandle,speak:codexLinuxReadAloudSpeak,stop:codexLinuxReadAloudStop,setup:codexLinuxReadAloudSetup,run:codexLinuxReadAloudRun})', context);
  return { root, custom, model, children, killed, sent, logs, app, proc, cp, context, api, patched: result.source };
}
function fixtureHost(h) {
  const target = {}, load = () => { throw Error("Unexpected fixture module import"); };
  load.d = (out, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(out, key, { get }); };
  h.context.exports.modules[82820]({}, target, load);
  return target.runMainAppStartup({ globalState: new Map(), cancelled: [],
    chunkedMessageSender: { sendInlineMessageForView: (view, message) => h.sent.push({ view, message }) } });
}
function nativeHost(h) {
  const graph = inspectMainRequestSites(h.patched); assert.equal(graph.ok, true);
  const body = site => h.patched.slice(site.methodBodyStart, site.methodBodyEnd);
  const wrapperBody = body(graph.wrapperRequest), viewBody = body(graph.viewFetch);
  const privateNames = [...new Set(viewBody.match(/#[A-Za-z_$][\w$]*/gu) || [])];
  const classes = `class ReadAloudNativeWrapper{async handleRequest(${graph.wrapperRequest.webContentsVar},${graph.wrapperRequest.requestVar}){${wrapperBody}}}` +
    `class ReadAloudNativeView{${privateNames.map(name => name + ";").join("")}async handleMessage(${graph.viewFetch.webContentsVar},${graph.viewFetch.requestVar}){${viewBody}}}` +
    ';({wrapper:ReadAloudNativeWrapper,view:ReadAloudNativeView})';
  const native = vm.runInContext(classes, h.context), wrapped = new native.wrapper(), owner = new native.view();
  wrapped.options = { chunkedMessageSender: { sendInlineMessageForView: (view, message) => h.sent.push({ view, message }) } };
  owner.fetchWrapper = wrapped;
  return owner;
}
function request(h, host, view, requestId, body) {
  return host.handleMessage(view, { type: "fetch", requestId, url: "vscode://codex/linux-read-aloud",
    body: typeof body === "string" ? body : JSON.stringify(body) });
}
function response(h, requestId) {
  const message = h.sent.find(row => row.message.requestId === requestId)?.message;
  assert.ok(message, requestId); return message;
}

for (const name of ["missing native owner", "wrong native responder", "partial helper", "route removed", "wrong route sender", "helper hidden in unused function", "helper hidden in native factory", "route hidden outside its prefix", "duplicate helper", "helper binding overwritten"]) {
  test(`normal main descriptor rejects ${name} without editing source`, () => {
    const pristine = fixture(), patched = applyMainBundlePatch(pristine), site = inspectMainRequestSites(patched).wrapperRequest;
    const route = patched.slice(site.prefixStart, site.prefixEnd), helper = patched.slice(patched.indexOf(START), patched.indexOf(END) + END.length);
    const variants = {
      "missing native owner": pristine.replace("async handleRequest(e,t)", "async unused(e,t)"),
      "wrong native responder": pristine.replaceAll("this.options.chunkedMessageSender.sendInlineMessageForView", "this.options.other.sendInlineMessageForView"),
      "partial helper": patched.replace('"speech-process-failed"', '"wrong-failure"'),
      "route removed": patched.replace(route, ""),
      "wrong route sender": patched.replace("codexLinuxReadAloudMessage=>this.options.chunkedMessageSender", "codexLinuxReadAloudMessage=>this.chunkedMessageSender"),
      "helper hidden in unused function": "function unused(){" + helper + "}\n" + patched.replace(helper, ""),
      "helper hidden in native factory": patched.replace(helper, "").replace("82820(module,exports,require){", "82820(module,exports,require){" + helper),
      "route hidden outside its prefix": patched.replace(route, "") + "\nasync function unusedRoute(){" + route + "}",
      "duplicate helper": helper + patched,
      "helper binding overwritten": patched + "\ncodexLinuxReadAloudFetch=()=>null;",
    };
    const damaged = variants[name]; assert.notEqual(damaged, pristine);
    const result = normal(damaged); assert.equal(result.source, damaged); assert.equal(result.patch.status, "skipped-optional");
  });
}

test("canonical main patch requires the native graph and exact owned prefix while other routes compose", () => {
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  const pristine = fixture(), applied = normal(pristine); assert.equal(applied.patch.status, "applied");
  assert.equal(normal(applied.source).patch.status, "already-applied");
  const graph = inspectMainRequestSites(applied.source), site = graph.wrapperRequest;
  const foreign = '/*codex-linux-fixture-route*/if("vscode://codex/fixture"===t?.url)return void await codexLinuxFixture(t,reply=>this.options.chunkedMessageSender.sendInlineMessageForView(e,reply));';
  const composed = applied.source.slice(0, site.prefixStart) + foreign + applied.source.slice(site.prefixStart);
  assert.equal(normal(composed).patch.status, "already-applied");
  const detached = applied.source.replace("await this.fetchWrapper.handleRequest(e,t)", "await this.other.handleRequest(e,t)");
  assert.equal(normal(detached).patch.status, "skipped-optional");
});

test("normal main route rejects Unicode-equivalent helper shadows and preserves encoded data", () => {
  const raw = fixture(), canonical = applyMainBundlePatch(raw), head = "82820(module,exports,require){";
  for (const name of ["codexLinuxReadAloudFetch", String.raw`codexLinuxReadAlou\u0064Fetch`,
    String.raw`codexLinuxReadAlou\u{64}Fetch`, String.raw`\u0063odexLinuxReadAloudFetch`]) {
    for (const source of [raw, canonical]) {
      const invalid = source.replace(head, head + `var ${name}=async()=>{};`);
      assert.notEqual(invalid, source); new vm.Script(invalid);
      const warnings = [], warn = console.warn; console.warn = message => warnings.push(String(message));
      try { assert.ok(applyMainBundlePatch(invalid) === invalid, name); }
      finally { console.warn = warn; }
      assert.equal(warnings.length, 1);
      const result = normal(invalid);
      assert.equal(result.patch.status, "skipped-optional");
      assert.ok(result.source === invalid);
    }
  }
  for (const data of [String.raw`const encodedNote="codexLinuxReadAlou\u0064Fetch";`,
    String.raw`/* codexLinuxReadAlou\u0064Fetch */`]) {
    const valid = raw.replace(head, head + data), result = normal(valid);
    assert.equal(result.patch.status, "applied");
    assert.equal(normal(result.source).patch.status, "already-applied");
  }
});

test("main inventory rejects duplicate, mixed and stray canonical cohorts before any write", () => {
  const good = fixture(), applied = applyMainBundlePatch(good);
  for (const other of [good, applied, '/*codex-linux-read-aloud-route*/', 'function codexLinuxReadAloudFetch(){}']) {
    const files = { "early-bootstrap.js": good, "early-bootstrap-2-aaaa.js": other }, result = normal(files);
    assert.equal(result.patch.status, "skipped-optional"); assert.deepEqual(result.files, files);
  }
  for (const copy of [fixture("return false", "82820"), fixture("return false", "8.282e4"), fixture("return false", '"82820"')]) {
    const files = { "early-bootstrap.js": good, "early-bootstrap-2-aaaa.js": copy }, result = normal(files);
    assert.equal(result.patch.status, "skipped-optional"); assert.deepEqual(result.files, files);
  }
  const unrelated = { "early-bootstrap.js": good, "early-bootstrap-2-aaaa.js": fixture('const facade="runMainAppStartup:";return false', "82821") };
  const accepted = normal(unrelated); assert.equal(accepted.patch.status, "applied");
  assert.equal(accepted.files["early-bootstrap-2-aaaa.js"], unrelated["early-bootstrap-2-aaaa.js"]);
  const damaged = good.replace("async handleRequest(e,t)", "async unused(e,t)");
  const files = { "early-bootstrap.js": good, "early-bootstrap-2-aaaa.js": damaged };
  assert.deepEqual(normal(files).files, files); assert.equal(normal(files).patch.status, "skipped-optional");
});

test("main transaction restores a partial write and raises integrity failure when restoration cannot be verified", t => {
  const root = ownedRoot(t), build = path.join(root, ".vite/build"); fs.mkdirSync(build, { recursive: true });
  const target = path.join(build, "early-bootstrap.js"), input = fixture(); fs.writeFileSync(target, input);
  let writes = 0;
  assert.throws(() => applyMainToExtractedApp(root, { writeFileSync(file, bytes) {
    writes++; if (writes === 1) { fs.writeFileSync(file, bytes.subarray(0, 30)); throw Error("fixture partial write"); }
    fs.writeFileSync(file, bytes);
  } }), /partial write/);
  assert.equal(fs.readFileSync(target, "utf8"), input);
  assert.throws(() => applyMainToExtractedApp(root, { writeFileSync(file) { fs.writeFileSync(file, "broken"); throw Error("fixture persistent write failure"); } }), /rollback could not restore original bytes/);
});

test("normal fetch path persists only owned settings and returns input/setup errors to the current view", async t => {
  const h = harness(t), host = fixtureHost(h), view = { id: 1 };
  const settings = path.join(h.root, "config", "codex-desktop", "settings.json"); fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ unrelated: { keep: true } }));
  await request(h, host, view, "set", { action: "set-setting", key: "codex-linux-read-aloud-enabled", value: true });
  await request(h, host, view, "pace", { action: "set-setting", key: "codex-linux-read-aloud-kokoro-speed", value: 100 });
  await request(h, host, view, "get", { action: "get-setting", key: "codex-linux-read-aloud-kokoro-speed" });
  await request(h, host, view, "bad-key", { action: "set-setting", key: "unrelated", value: null });
  await request(h, host, view, "bad-json", "{");
  await request(h, host, view, "cancel", { action: "setup", mode: "choose-folder" });
  await request(h, host, view, "no-python", { action: "setup", mode: "download" });
  const persisted = JSON.parse(fs.readFileSync(settings));
  assert.deepEqual(persisted, { unrelated: { keep: true }, "codex-linux-read-aloud-enabled": true, "codex-linux-read-aloud-kokoro-speed": 1.4 });
  assert.equal(JSON.parse(response(h, "get").bodyJsonString).value, 1.4);
  assert.equal(response(h, "bad-key").responseType, "error"); assert.equal(response(h, "bad-json").responseType, "error");
  assert.equal(JSON.parse(response(h, "cancel").bodyJsonString).reason, "cancelled");
  assert.equal(JSON.parse(response(h, "no-python").bodyJsonString).reason, "python-unavailable");
  assert.ok(h.sent.every(row => row.view === view)); assert.equal(h.children.length, 0);
});

test("explicit speech waits for spawn ack; async launch error is handled and repeated stop is idle", async t => {
  const h = harness(t, { manual: true }); h.proc.env.CODEX_LINUX_READ_ALOUD_COMMAND = h.custom;
  assert.equal((await h.api.speak("not enabled")).reason, "disabled"); assert.equal(h.children.length, 0);
  assert.equal((await h.api.handle({ action: "speak", text: "no button" })).reason, "not-explicit");
  const pending = h.api.handle({ action: "speak", source: "button", text: "hello" }); let answered = false; pending.then(() => { answered = true; });
  await tick(); assert.equal(answered, false); assert.equal(h.children.length, 1);
  assert.doesNotThrow(() => h.children[0].child.emit("error", Error("fixture async ENOENT")));
  assert.equal((await pending).reason, "custom-spawn-failed");
  assert.equal(h.api.stop().reason, "idle"); assert.equal(h.api.stop().reason, "idle");
});

test("stop and a superseding request cancel pending launch without starting a fallback", async t => {
  const h = harness(t, { manual: true }); h.proc.env.CODEX_LINUX_READ_ALOUD_COMMAND = h.custom;
  const first = h.api.handle({ action: "speak", source: "button", text: "first" }); await tick();
  assert.equal(h.api.stop().stopped, true); assert.equal((await first).reason, "cancelled");
  h.children[0].child.emit("spawn"); assert.equal(h.api.stop().reason, "idle");
  const second = h.api.handle({ action: "speak", source: "button", text: "second" }); await tick();
  const third = h.api.handle({ action: "speak", source: "button", text: "third" }); await tick();
  assert.equal((await second).reason, "cancelled"); h.children.at(-1).child.emit("spawn");
  assert.equal((await third).spoken, true); assert.equal(h.children.length, 3);
  const last = h.children.at(-1).child; assert.doesNotThrow(() => h.children[1].child.emit("error", Error("late old failure")));
  assert.equal(h.api.stop().stopped, true); assert.ok(h.killed.some(([pid]) => pid === -last.pid));
});

test("Piper owns both process groups and final quit/exit clean only feature-owned children", async t => {
  const h = harness(t); h.proc.env.CODEX_LINUX_READ_ALOUD_ENGINE = "piper"; h.proc.env.CODEX_LINUX_READ_ALOUD_PIPER_MODEL = h.model;
  h.proc.env.CODEX_LINUX_READ_ALOUD_PIPER_BIN = h.custom; h.cp.spawnSync = () => ({ status: 0 });
  const spoken = await h.api.handle({ action: "speak", source: "button", text: "pipeline" }); assert.equal(spoken.spoken, true);
  assert.equal(h.children.length, 2); const pids = h.children.map(row => row.child.pid);
  assert.equal(h.app.listenerCount("before-quit"), 0); assert.equal(h.app.listenerCount("window-all-closed"), 0);
  h.app.emit("before-quit", { preventDefault() {} }); assert.equal(h.killed.length, 0);
  h.app.emit("quit"); assert.deepEqual(h.killed.map(([pid]) => pid).sort(), pids.map(pid => -pid).sort());
  h.proc.emit("exit"); assert.equal(h.killed.length, 2); assert.equal(h.api.stop().reason, "idle");
});

test("late pipeline failure kills its partner; natural exit and stdin errors never retain stale ownership", async t => {
  const h = harness(t); h.proc.env.CODEX_LINUX_READ_ALOUD_COMMAND = h.custom;
  assert.equal((await h.api.handle({ action: "speak", source: "button", text: "stream" })).spoken, true);
  const child = h.children[0].child; assert.doesNotThrow(() => child.stdin.emit("error", Error("fixture EPIPE")));
  assert.equal(h.api.stop().reason, "idle");
  assert.equal((await h.api.handle({ action: "speak", source: "button", text: "next" })).spoken, true);
  h.children.at(-1).child.emit("exit", 0); h.children.at(-1).child.emit("close", 0); assert.equal(h.api.stop().reason, "idle");
});

test("Piper startup and late process errors dispose both owned groups", async t => {
  const h = harness(t, { manual: true }); h.proc.env.CODEX_LINUX_READ_ALOUD_ENGINE = "piper";
  h.proc.env.CODEX_LINUX_READ_ALOUD_PIPER_MODEL = h.model; h.proc.env.CODEX_LINUX_READ_ALOUD_PIPER_BIN = h.custom;
  h.cp.spawnSync = () => ({ status: 0 });
  const pending = h.api.handle({ action: "speak", source: "button", text: "failed pipeline" }); await tick();
  h.children[0].child.emit("spawn"); await tick(); assert.equal(h.children.length, 2);
  assert.doesNotThrow(() => h.children[1].child.emit("error", Error("fixture player launch failure")));
  assert.equal((await pending).reason, "piper-unavailable"); assert.equal(h.killed.length, 2); assert.equal(h.api.stop().reason, "idle");
  const next = h.api.handle({ action: "speak", source: "button", text: "late failure" }); await tick();
  h.children[2].child.emit("spawn"); await tick(); h.children[3].child.emit("spawn"); assert.equal((await next).spoken, true);
  h.children[2].child.emit("exit", 0);
  assert.doesNotThrow(() => h.children[2].child.stdout.emit("error", Error("fixture post-exit stream failure")));
  assert.equal(h.killed.length, 4); assert.equal(h.api.stop().reason, "idle");
  const latest = h.api.handle({ action: "speak", source: "button", text: "new generation" }); await tick();
  h.children[4].child.emit("spawn"); await tick(); h.children[5].child.emit("spawn"); assert.equal((await latest).spoken, true);
  assert.doesNotThrow(() => h.children[2].child.stdout.emit("error", Error("fixture old generation stream failure")));
  h.children[2].child.emit("close", 0); assert.equal(h.killed.length, 4, "old stdio events must not stop new playback");
  assert.equal(h.api.stop().stopped, true); assert.equal(h.killed.length, 6);
});

test("missing runtime, synchronous spawn failure and settings write failure have deterministic replies", async t => {
  const h = harness(t); h.proc.env.CODEX_LINUX_READ_ALOUD_COMMAND = path.join(h.root, "missing");
  assert.equal((await h.api.handle({ action: "speak", source: "button", text: "unavailable" })).reason, "custom-spawn-failed");
  assert.equal(h.children.length, 0); h.proc.env.CODEX_LINUX_READ_ALOUD_COMMAND = h.custom;
  h.cp.spawn = () => { throw Error("fixture synchronous failure"); };
  assert.equal((await h.api.handle({ action: "speak", source: "button", text: "failed" })).reason, "custom-spawn-failed");
  assert.equal(h.api.stop().reason, "idle");
  const failingIo = { ...fs, writeFileSync() { throw Error("fixture disk full"); } };
  const failed = harness(t, { io: failingIo }), host = fixtureHost(failed), view = { id: 2 };
  await request(failed, host, view, "write-error", { action: "set-setting", key: "codex-linux-read-aloud-enabled", value: true });
  assert.equal(response(failed, "write-error").responseType, "error"); assert.match(response(failed, "write-error").error, /disk full/);
});

test("actual process exit cancels owned setup commands without coupling stop to setup", async t => {
  const h = harness(t, { manual: true });
  const setup = h.api.run(h.custom, ["fixture-setup"], 10000).then(() => "unexpected", error => error.message);
  assert.equal(h.api.stop().reason, "idle"); assert.equal(h.killed.length, 0);
  h.proc.emit("exit"); assert.equal(await setup, "command cancelled"); assert.equal(h.killed.length, 1);
});

test("signed native request methods deliver feature actions to the current view without native startup", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, async t => {
  const official = process.env.CODEX_SIGNED_EXTRACTED_APP, main = findMainProcessChunks(official);
  const owners = main.chunks.map(name => ({ name, file: path.join(main.buildDir, name) }))
    .map(row => ({ ...row, source: fs.readFileSync(row.file, "utf8") })).filter(row => inspectMainRequestSites(row.source).ok);
  assert.equal(owners.length, 1); const owner = owners[0], before = crypto.createHash("sha256").update(owner.source).digest("hex");
  const inventory = Object.fromEntries(main.chunks.map(name => [name, fs.readFileSync(path.join(main.buildDir, name), "utf8")]));
  const committed = normal(inventory); assert.equal(committed.patch.status, "applied");
  assert.deepEqual(Object.keys(inventory).filter(name => inventory[name] !== committed.files[name]), [owner.name]);
  assert.equal(normal(committed.files).patch.status, "already-applied");
  const h = harness(t, { source: owner.source }); const host = nativeHost(h), view = { id: "signed-native-view" };
  h.proc.env.CODEX_LINUX_READ_ALOUD_COMMAND = h.custom;
  await request(h, host, view, "config", { action: "config" });
  await request(h, host, view, "set", { action: "set-setting", key: "codex-linux-read-aloud-enabled", value: true });
  await request(h, host, view, "speak", { action: "speak", source: "button", text: "native request" });
  await request(h, host, view, "stop", { action: "stop" }); await request(h, host, view, "again", { action: "stop" });
  await request(h, host, view, "setup", { action: "setup", mode: "choose-folder" });
  assert.equal(JSON.parse(response(h, "speak").bodyJsonString).spoken, true);
  assert.equal(JSON.parse(response(h, "stop").bodyJsonString).stopped, true);
  assert.equal(JSON.parse(response(h, "again").bodyJsonString).reason, "idle");
  assert.equal(JSON.parse(response(h, "setup").bodyJsonString).reason, "cancelled");
  assert.ok(h.sent.every(row => row.view === view)); assert.equal(normal(h.patched).patch.status, "already-applied");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(owner.file)).digest("hex"), before);
});
