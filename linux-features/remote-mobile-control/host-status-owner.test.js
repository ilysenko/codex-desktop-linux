"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const fixture = require("./fixtures/current-host-toggle.json");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { inspectHostStatusOwner, prepareStatusReadSource, READ_MARKER, WAIT_EXPRESSION } = require("./host-status-owner.js");
const old = require("./patch.js");
function native() { return { ...fixture.modules.find(row => row.moduleId === "ihPm"), start: 0 }; }
function mutate(copy, before, after) { assert.equal(copy.moduleSource.split(before).length, 2);return { ...copy, moduleSource: copy.moduleSource.replace(before, after) }; }
function deferred() { let resolve, reject;const promise = new Promise((a, b) => { resolve = a; reject = b; });return { promise, resolve, reject }; }
function runtime({ platform = "Linux", host = "local", isCurrent = () => true, initial } = {}) {
  const copy = native(), plan = prepareStatusReadSource(copy), pub = findRspackExportPublication({ ...copy, moduleSource: plan.patchedSource }, "UL");
  const status = "native-status", override = "native-override", values = new Map([[host, initial]]), writes = [], calls = [], logs = [], read = deferred();
  let subscription, ready, stopped = 0, readyStopped = 0, fulfill, reject, pendingBroken, readyBroken;
  const context = { AbortController, Symbol, u: status, d: override,
    i: { C: value => value === "durable" }, a: { P: promise => promise }, o: { v: { error(...args) { logs.push(args); } } } };
  if (platform !== null) context.navigator = { userAgent: platform };
  const mapper = 'function p(e,t,n){n?.status==="connected"&&e.set(d,t,!1),e.set(u,t,n)}';
  const fn = vm.runInNewContext(`${mapper};(function(${pub.fn.params}){${pub.fn.body}})`, context);
  const store = { get: (atom, key) => atom === status ? values.get(key) : undefined,
    set(atom, key, value) { writes.push({ atom, key, value });if (atom === status) values.set(key, value); } };
  const client = { subscribe(spec) {
    subscription = spec;
    return { then(a, b) { fulfill = a; reject = b; }, onRpcBroken(callback) { pendingBroken = callback; }, [Symbol.dispose]() { stopped++; } };
  }, sendRequest(method, params) { calls.push({ method, params });return read.promise; } };
  const stop = fn(store, host, client, isCurrent);
  return { host, calls, logs, writes, values, read, stop,
    get subscription() { return subscription; }, get disposed() { return stopped; }, get readyDisposed() { return readyStopped; },
    notify(value) { subscription.listener({ params: value }); },
    ready() { ready = { onRpcBroken(callback) { readyBroken = callback; }, [Symbol.dispose]() { readyStopped++; } };fulfill(ready); },
    pendingBroken() { pendingBroken(); }, readyBroken() { readyBroken(); }, rejectSubscription(error) { reject(error); } };
}
async function flush() { await Promise.resolve();await Promise.resolve(); }

test("current native read contribution is byte-identical to the existing API and composes with exact wait peer", () => {
  const c = native(), p = prepareStatusReadSource(c);
  assert.equal(p.patchedSource.length - c.moduleSource.length, 329);
  assert.equal(require("node:crypto").createHash("sha256").update(p.patchedSource).digest("hex"), "297c1bdd9749e13045a388a741c0057129a00fdb46854870808e8db4f598e201", "established3bflegacy329Boutput is preserved without retaining the retired matcher");
  assert.equal(p.nativeSource, c.moduleSource);
  assert.equal(prepareStatusReadSource({ ...c, moduleSource: p.patchedSource }).patchedSource, p.patchedSource);
  const wait = old.applyLinuxRemoteControlStatusWaitPatch(c.moduleSource), both = prepareStatusReadSource({ ...c, moduleSource: wait });
  assert.equal(both.nativeSource, wait);assert.equal(both.patchedSource, old.applyLinuxRemoteControlStatusWaitPatch(p.patchedSource));
  const inverse = prepareStatusReadSource({ ...c, moduleSource: both.patchedSource });
  assert.equal(inverse.nativeSource, wait);assert.equal(inspectHostStatusOwner({ ...c, moduleSource: both.patchedSource }).waitPeer, true);
});

test("24 platform/host cases retain exact prefix policy and native durable skip", async () => {
  const hosts = ["local", "remote-ssh:session", "remote-ssh-discovered:id", "remote-control:id", "remote-wsl:id", "cloud-id", "durable", { nativeHost: true }];
  for (const platform of ["Linux", "Mac", null]) for (const [index, host] of hosts.entries()) {
    const r = runtime({ platform, host }), durable = index === 6, blocked = platform === "Linux" && [1, 2, 3].includes(index);
    assert.equal(r.calls.length, durable || blocked ? 0 : 1);
    if (durable) { assert.equal(r.subscription, undefined);r.stop();continue; }
    assert.equal(r.subscription.key.hostId, host);assert.equal(r.subscription.methods, "remoteControl/status/changed");
    if (blocked) {
      assert.deepEqual(JSON.parse(JSON.stringify(r.values.get(host))), { status: "disabled", available: false, accessRequired: false });
    } else {
      assert.deepEqual(r.calls, [{ method: "remoteControl/status/read", params: undefined }]);
      r.read.resolve({ status: "connecting" });await flush();assert.equal(r.values.get(host).status, "connecting");
    }
    r.notify({ status: "connected" });assert.equal(r.values.get(host).status, "connected");
    r.stop();assert.equal(r.disposed, 1);
  }
});

test("read response cannot replace a newer notification and native current guard isolates another host", async () => {
  const initial = { status: "connecting" }, r = runtime({ initial });
  const newest = { status: "connected" };r.notify(newest);r.read.resolve({ status: "errored" });await flush();assert.equal(r.values.get("local"), newest);
  r.stop();r.notify({ status: "errored" });assert.equal(r.values.get("local"), newest);
  let active = true;const oldHost = runtime({ host: "old", isCurrent: () => active }), newHost = runtime({ host: "new" });
  active = false;oldHost.notify({ status: "connected" });oldHost.read.resolve({ status: "connected" });await flush();assert.equal(oldHost.writes.length, 0);
  newHost.notify({ status: "connected" });assert.equal(newHost.values.get("new").status, "connected");
  oldHost.stop();newHost.stop();
});

test("cleanup is idempotent for pending and ready handles, including late ready resolution", async () => {
  const pending = runtime();pending.stop();pending.stop();assert.equal(pending.disposed, 1);pending.ready();assert.equal(pending.readyDisposed, 1);
  const ready = runtime();ready.ready();ready.readyBroken();ready.stop();assert.equal(ready.disposed, 1);assert.equal(ready.readyDisposed, 1);
  const failed = runtime();failed.rejectSubscription(Error("controlled subscription failure"));failed.stop();assert.equal(failed.disposed, 1);
  pending.read.resolve({ status: "connected" });ready.read.resolve({ status: "connected" });failed.read.resolve({ status: "connected" });await flush();
  assert.equal(pending.writes.length, 0);assert.equal(ready.writes.length, 0);assert.equal(failed.writes.length, 0);
});

test("native read errors log only while current and never alter another host", async () => {
  const error = Error("controlled status failure"), active = runtime();active.read.reject(error);await flush();assert.equal(active.logs.length, 1);assert.equal(active.logs[0][1].sensitive.error, error);active.stop();
  const stopped = runtime();stopped.stop();stopped.read.reject(error);await flush();assert.equal(stopped.logs.length, 0);
});

test("coherent own binding, intrinsic, wrong-host, mutable provider and partial peer mutations reject", () => {
  const c = native();
  for (const bad of [
    { ...c, moduleSource: c.moduleSource + 'function p(e,t,n){return null}' },
    { ...c, params: ["navigator", "t", "n"] },
    { ...c, params: ["Error", "t", "n"] },
    mutate(c, 'key:{hostId:t}', 'key:{hostId:"wrong"}'),
    { ...c, moduleSource: c.moduleSource + ';a=other;' },
    { ...c, moduleSource: c.moduleSource + `/*${READ_MARKER}*/` },
  ]) assert.throws(() => prepareStatusReadSource(bad));
  const wait = old.applyLinuxRemoteControlStatusWaitPatch(c.moduleSource);
  assert.throws(() => prepareStatusReadSource(mutate({ ...c, moduleSource: wait }, WAIT_EXPRESSION, WAIT_EXPRESSION.replace("3e4", "3e5"))));
  const read = prepareStatusReadSource(c).patchedSource;
  assert.throws(() => prepareStatusReadSource(mutate({ ...c, moduleSource: read }, 'e.startsWith(`remote-ssh`)', 'e.startsWith(`remote-wsl`)')));
});

test("consumer cannot change the certified native setter or read span after inspection", () => {
  const proof = inspectHostStatusOwner(native());
  assert.throws(() => { proof.read.roles.setter = "otherHostSetter"; }, TypeError);
  assert.throws(() => { proof.read.fn.bodyStart = 0; }, TypeError);
  assert.throws(() => { proof.imports[1].moduleId = "otherClassifier"; }, TypeError);
  const p = prepareStatusReadSource(native());assert.equal(p.patchedSource.length - p.nativeSource.length, 329);
});
