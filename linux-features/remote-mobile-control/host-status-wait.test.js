"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm"), crypto = require("node:crypto");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { prepareStatusWaitSource, prepareStatusWaitString, applyStatusWaitPatch, locateStatusWaitCohort } = require("./host-status-wait.js");
const { prepareStatusReadSource, WAIT_MARKER, WAIT_EXPRESSION } = require("./host-status-owner.js");
const { applyStatusReadPatch } = require("./host-status.js");
const host = require("./fixtures/current-host-toggle.json").modules.find(row => row.moduleId === "ihPm"), graph = require("./fixtures/current-host-status-graph.json").modules, facades = require("./fixtures/current-enablement-bridge.json").facades;
function copy() { return { ...host, start: 0 }; }
function carrier(rows) { return `export const __webpack_modules__={${rows.map(row => `${JSON.stringify(row.moduleId)}(${row.params.join(",")}){${row.moduleSource}}`).join(",")}};`; }
function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-status-wait-"));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assets = path.join(dir, "webview/assets");fs.mkdirSync(assets, { recursive: true });
  const groups = { "a.js": [host], "b.js": [host], "lifecycle.js": graph.filter(row => ["dbK8", "hms3", "J8Ro"].includes(row.moduleId)), "literal.js": graph.filter(row => ["DBCl", "N2rm"].includes(row.moduleId)), "awaiter.js": graph.filter(row => row.moduleId === "q77y"), "service-a.js": [facades[0]], "service-b.js": [facades[1]] };
  for (const [name, rows] of Object.entries(groups)) fs.writeFileSync(path.join(assets, name), carrier(rows));
  return { dir, assets };
}
function snapshot(assets) { return Object.fromEntries(fs.readdirSync(assets).sort().map(name => [name, { bytes: fs.readFileSync(path.join(assets, name)), mode: fs.statSync(path.join(assets, name)).mode & 0o777 }])); }
function runtime({ platform = "Linux", selectedHost = "selected", initial, ignoreCurrentError = false, watchInitial } = {}) {
  const c = copy(), prepared = prepareStatusWaitSource(c), published = findRspackExportPublication({ ...c, moduleSource: prepared.patchedSource }, "Hf");
  const native = c.moduleSource, begin = native.indexOf("function h("), open = native.indexOf("{", begin), close = createJavaScriptLexicalIndex(native).matchingBrace(open);
  assert.ok(begin >= 0 && close > open);const classifier = native.slice(begin, close + 1);
  const atom = "native-host-status", values = new Map([[selectedHost, initial]]), watches = new Set(), callbacks = [], observedHosts = [], timers = new Map();let nextId = 0, now = 0, disposed = 0, cleared = 0;
  class ConnectionError extends Error { constructor() { super("Remote control failed to connect");this.name = "RemoteControlConnectionFailedError"; } }
  const context = { Error, Promise, l: ConnectionError, u: atom, setTimeout(callback, milliseconds) { const id = ++nextId;timers.set(id, { callback, at: now + milliseconds, milliseconds });return id; }, clearTimeout(id) { cleared++;timers.delete(id); } };
  if (platform !== null) context.navigator = { userAgent: platform };
  const fn = vm.runInNewContext(`${classifier};(function(${published.fn.params}){${published.fn.body}})`, context);
  const read = (which, key) => { assert.equal(which, atom);observedHosts.push(key);return values.get(key); };
  const store = { get: read, watch(callback) { watches.add(callback);callbacks.push(callback);if (watchInitial !== undefined) { values.set(selectedHost, watchInitial);callback({ get: read }); }return () => { disposed++;watches.delete(callback); }; } };
  const state = { kind: "pending" }, promise = fn(store, selectedHost, { ignoreCurrentError });
  promise.then(value => { state.kind = "resolved";state.value = value; }, error => { state.kind = "rejected";state.error = error; });
  return { state, promise, values, callbacks, observedHosts, timers,
    get disposed() { return disposed; }, get cleared() { return cleared; }, get watchers() { return watches.size; },
    notify(hostId, value) { values.set(hostId, value);for (const callback of [...watches]) callback({ get: read }); },
    advance(milliseconds) { now += milliseconds;for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(id);timer.callback(); } } };
}
async function flush() { await Promise.resolve();await Promise.resolve(); }

test("native wait output retains exact established112B and each inverse preserves the read peer", () => {
  const c = copy(), wait = prepareStatusWaitSource(c), hash = text => crypto.createHash("sha256").update(text).digest("hex");
  assert.equal(wait.patchedSource.length - c.moduleSource.length, 112);assert.equal(hash(wait.patchedSource), "c36b3bcf2a58cd6c51e6176dba7977c1390fbea0d718ca4cc4ff2ae5e78e8da1");
  assert.equal(wait.nativeSource, c.moduleSource);assert.equal(prepareStatusWaitSource({ ...c, moduleSource: wait.patchedSource }).patchedSource, wait.patchedSource);
  const read = prepareStatusReadSource(c).patchedSource, both = prepareStatusWaitSource({ ...c, moduleSource: read });
  assert.equal(both.nativeSource, read);assert.equal(both.patchedSource, prepareStatusReadSource({ ...c, moduleSource: wait.patchedSource }).patchedSource);
  assert.equal(prepareStatusWaitSource({ ...c, moduleSource: both.patchedSource }).nativeSource, read);
});

test("Linux gets30000ms and other or missing navigator retains5000ms with native rejection and cleanup", async () => {
  for (const platform of ["Linux", "Mac", "Windows", null]) {
    const r = runtime({ platform, initial: { status: "connecting" } }), expected = platform === "Linux" ? 30000 : 5000;
    assert.equal([...r.timers.values()][0].milliseconds, expected);r.advance(expected - 1);await flush();assert.equal(r.state.kind, "pending");
    r.advance(1);await flush();assert.equal(r.state.kind, "rejected");assert.equal(r.state.error.message, "Timed out waiting for remote control to connect");assert.equal(r.disposed, 1);assert.equal(r.cleared, 1);assert.equal(r.watchers, 0);assert.equal(r.timers.size, 0);
  }
});

test("only the supplied host can converge during the extended window", async () => {
  const r = runtime({ initial: { status: "disabled" } });r.notify("other", { status: "connected" });r.advance(29000);await flush();assert.equal(r.state.kind, "pending");
  const connected = { status: "connected" };r.notify("selected", connected);await flush();assert.equal(r.state.kind, "resolved");assert.equal(r.state.value, connected);assert.ok(r.observedHosts.every(host => host === "selected"));
  assert.equal(r.disposed, 1);assert.equal(r.cleared, 1);r.advance(100000);await flush();assert.equal(r.state.value, connected);assert.equal(r.disposed, 1);
});

test("native immediate connected/error results allocate no timer or watcher", async () => {
  const connected = { status: "connected" }, success = runtime({ initial: connected }), failed = runtime({ initial: { status: "errored" } });await flush();
  assert.equal(success.state.value, connected);assert.equal(failed.state.kind, "rejected");assert.equal(failed.state.error.name, "RemoteControlConnectionFailedError");
  for (const r of [success, failed]) { assert.equal(r.timers.size, 0);assert.equal(r.callbacks.length, 0);assert.equal(r.disposed, 0); }
});

test("ignoreCurrentError ignores exactly the initial error identity and a new error rejects", async () => {
  const initial = { status: "errored" }, r = runtime({ initial, ignoreCurrentError: true });r.notify("selected", initial);r.notify("other", { status: "connected" });await flush();assert.equal(r.state.kind, "pending");
  r.notify("selected", { status: "errored" });await flush();assert.equal(r.state.kind, "rejected");assert.equal(r.state.error.name, "RemoteControlConnectionFailedError");assert.equal(r.disposed, 1);assert.equal(r.timers.size, 0);
});

test("a synchronous watch result and late callback dispose the native handle exactly once", async () => {
  const connected = { status: "connected" }, r = runtime({ initial: null, watchInitial: connected });await flush();assert.equal(r.state.value, connected);assert.equal(r.disposed, 1);assert.equal(r.cleared, 1);assert.equal(r.watchers, 0);
  r.values.set("selected", { status: "errored" });r.callbacks[0]({ get: (_atom, key) => r.values.get(key) });await flush();assert.equal(r.state.value, connected);assert.equal(r.disposed, 1);assert.equal(r.cleared, 1);
});

test("all physical waits use one atomic transaction and readonly dependencies keep bytes and modes", t => {
  const s = scene(t), before = snapshot(s.assets), first = applyStatusWaitPatch(s.dir);assert.equal(first.changed, 2);assert.equal(first.targetCopies, 2);
  const after = snapshot(s.assets);for (const name of ["a.js", "b.js"]) assert.equal(after[name].bytes.length - before[name].bytes.length, 112);
  for (const name of ["lifecycle.js", "literal.js", "awaiter.js", "service-a.js", "service-b.js"]) assert.deepEqual(after[name], before[name]);
  assert.equal(applyStatusWaitPatch(s.dir).changed, 0);assert.deepEqual(snapshot(s.assets), after);assert.equal(locateStatusWaitCohort(s.assets).readPeer, false);
});

test("registered read and wait APIs commute without applying the absent peer", t => {
  const a = scene(t), b = scene(t);applyStatusReadPatch(a.dir);applyStatusWaitPatch(a.dir);applyStatusWaitPatch(b.dir);applyStatusReadPatch(b.dir);
  assert.deepEqual(snapshot(a.assets), snapshot(b.assets));assert.equal(locateStatusWaitCohort(a.assets).readPeer, true);assert.equal(applyStatusWaitPatch(a.dir).changed, 0);
});

test("hidden malformed owners, mixed read/wait peers and missing dependencies reject before writes", t => {
  for (const kind of ["hidden", "read", "wait", "literal"]) {
    const s = scene(t);
    if (kind === "hidden") fs.writeFileSync(path.join(s.assets, "hidden.js"), carrier([{ ...host, moduleSource: host.moduleSource.replace("},5e3)", "},4e3)") }]));
    else if (kind === "literal") fs.unlinkSync(path.join(s.assets, "literal.js"));
    else { const p = path.join(s.assets, "a.js"), text = fs.readFileSync(p, "utf8");fs.writeFileSync(p, kind === "wait" ? prepareStatusWaitString(text) : require("./host-status.js").prepareStatusReadString(text)); }
    const before = snapshot(s.assets);assert.throws(() => applyStatusWaitPatch(s.dir));assert.deepEqual(snapshot(s.assets), before);
  }
});

test("late readonly service changes stop wait writes", t => {
  const s = scene(t), before = snapshot(s.assets);let changed = false;
  assert.throws(() => applyStatusWaitPatch(s.dir, { readFileSync(file) { if (!changed && String(file).endsWith("service-a.js")) { changed = true;fs.appendFileSync(file, "\n// changed dependency"); }return fs.readFileSync(file); } }), /changed before patch commit/);
  const after = snapshot(s.assets);for (const name of ["a.js", "b.js"]) assert.deepEqual(after[name], before[name]);
});

test("a partial second wait write restores all attempted bytes and original modes", t => {
  const s = scene(t);fs.chmodSync(path.join(s.assets, "a.js"), 0o640);const before = snapshot(s.assets);let failed = false;
  assert.throws(() => applyStatusWaitPatch(s.dir, { writeFileSync(file, bytes) { if (!failed && String(file).endsWith("b.js") && bytes.includes(Buffer.from(WAIT_MARKER))) { failed = true;fs.writeFileSync(file, bytes.subarray(0, 7));throw Error("controlled partial wait write"); }fs.writeFileSync(file, bytes); } }), /partial wait write/);
  assert.equal(failed, true);assert.deepEqual(snapshot(s.assets), before);
});

test("String entry rejects missing, duplicate, partial, altered timeout and orphan contributions", () => {
  const native = carrier([host]), patched = prepareStatusWaitString(native);assert.equal(prepareStatusWaitString(patched), patched);
  for (const bad of ["const unrelated=1;", native + native, native + `/*${WAIT_MARKER}*/`, patched.replace(WAIT_EXPRESSION, WAIT_EXPRESSION.replace("3e4", "3e5")), native.replace("},5e3)", "},4e3)")]) assert.throws(() => prepareStatusWaitString(bad));
  assert.throws(() => prepareStatusWaitString("stale", { factorySnapshot: copy() }), /stale/);
});


test("wait transaction requires the current subscriber queued-work cancellation before writing", t => {
  const s = scene(t), file = path.join(s.assets, "lifecycle.js");
  const source = fs.readFileSync(file, "utf8");
  assert.equal(source.split("ru.cancel()").length, 2);
  fs.writeFileSync(file, source.replace("ru.cancel()", "ru.dispose()"));
  const before = snapshot(s.assets);
  assert.throws(() => applyStatusWaitPatch(s.dir), /published native status subscriber lifecycle/);
  assert.deepEqual(snapshot(s.assets), before);
});
