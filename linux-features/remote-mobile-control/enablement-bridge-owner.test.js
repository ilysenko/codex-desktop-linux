"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const fixture = require("./fixtures/current-enablement-bridge.json");
const { prepareBridgeOwner, inspectBridgeOwner, inspectPairingGate, inspectNativeGateHook, MARKER } = require("./enablement-bridge-owner.js");
const { inspectAppServicesFacade } = require("./renderer-remote-connections-owners.js");
function snapshot() {
  const f = fixture.bridgeFragments;
  return { moduleId: f.moduleId, params: f.params, start: 0,
    moduleSource: "var " + f.imports.map(row => `${row.local}=n(${JSON.stringify(row.moduleId)})`).join(",") + ";" + f.functions.map(row => row.source).join("") };
}
function change(copy, before, after) {
  assert.equal(copy.moduleSource.split(before).length, 2, "negative fixture changes a real unique source span");
  return { ...copy, moduleSource: copy.moduleSource.replace(before, after) };
}
function runtime(owner, { platform = "Linux", oneToOne = false, gate = false, loading = false } = {}) {
  const cache = [], calls = [], effects = [], checks = [], warnings = [];
  let service = { setRemoteControlEnabled(payload) { calls.push(payload); return Promise.resolve(); } }, hookCalls = 0, facadeReads = 0;
  const gateReader = id => { checks.push(id); return id === "2055603567" ? oneToOne : gate; };
  const scope = { c: { c: size => { assert.equal(size, 10); return cache; } },
    eg: { cn: () => { hookCalls++; return { checkGate: gateReader, isLoading: loading }; } },
    rm: { Qg: "2055603567" }, t4: { get appServices() { facadeReads++; return { remoteConnections: service }; } },
    v: { v: { warning(...args) { warnings.push(args); } } }, u: { useEffect: (effect, deps) => effects.push({ effect, deps }) } };
  if (platform !== null) scope.navigator = { userAgent: platform };
  const fn = vm.runInNewContext(`(${owner})`, scope);
  return { render: () => fn(), calls, effects, checks, warnings,
    get hooks() { return hookCalls; }, get reads() { return facadeReads; },
    setService(next) { service = next; } };
}

test("native bounded bridge and dependencies preserve canonical inverse and exact surrounding bytes", () => {
  const c = snapshot(), p = prepareBridgeOwner(c);
  assert.equal(p.proof.owner.source.length, 595); assert.equal(p.proof.caller.source.length, 141); assert.equal(p.proof.render.source.length, 6790);
  assert.equal(p.patchedSource.length - c.moduleSource.length, 113);
  assert.equal(p.nativeSource, c.moduleSource);
  const repeat = prepareBridgeOwner({ ...c, moduleSource: p.patchedSource });
  assert.equal(repeat.patchedSource, p.patchedSource); assert.equal(repeat.nativeSource, c.moduleSource);
  assert.equal(inspectPairingGate({ ...fixture.pairing, start: 0 }, "Qg").gate, "2055603567");
  assert.equal(inspectNativeGateHook({ ...fixture.hook, start: 0 }, "cn").react.moduleId, p.proof.imports.react.moduleId);
  for (const f of fixture.facades) assert.equal(inspectAppServicesFacade(f).moduleId, p.proof.imports.facade.moduleId);
});

test("24 native hook/cache/effect policy cases retain loading, one-to-one and non-Linux payloads", async () => {
  const plan = prepareBridgeOwner(snapshot());
  for (const platform of ["Linux", "Mac", null]) for (const oneToOne of [false, true]) for (const gate of [false, true]) for (const loading of [false, true]) {
    const owner = inspectBridgeOwner({ ...snapshot(), moduleSource: plan.patchedSource }).owner.source;
    const r = runtime(owner, { platform, oneToOne, gate, loading });
    assert.equal(r.render(), null); assert.equal(r.hooks, 1); assert.deepEqual(r.checks, ["2055603567", "1042620455"]);
    r.effects[0].effect(); await Promise.resolve();
    assert.equal(r.calls.length, loading ? 0 : 1);
    if (!loading) assert.deepEqual(JSON.parse(JSON.stringify(r.calls[0])), { enabled: gate || oneToOne || platform === "Linux", oneToOnePairingInAppEnabled: oneToOne });
    assert.equal(r.render(), null); assert.equal(r.hooks, 2); assert.equal(r.checks.length, 2, "native memo cache avoids repeated gate evaluation");
    assert.equal(r.effects[0].effect, r.effects[1].effect);
    assert.equal(r.effects[0].deps, r.effects[1].deps);
  }
});

test("effect reads late injected service, preserves native rejection/log and truthy result identity", async () => {
  const p = prepareBridgeOwner(snapshot()), owner = inspectBridgeOwner({ ...snapshot(), moduleSource: p.patchedSource }).owner.source;
  const r = runtime(owner); r.render(); assert.equal(r.reads, 0);
  r.setService(null); r.effects[0].effect(); assert.equal(r.reads, 1); assert.equal(r.calls.length, 0);
  const error = Error("controlled native service rejection"), calls = [];
  r.setService({ setRemoteControlEnabled(payload) { calls.push(payload); return Promise.reject(error); } });
  r.effects[0].effect(); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 1); assert.equal(r.warnings.length, 1); assert.equal(r.warnings[0][1].sensitive.error, error);
  assert.equal(r.warnings[0][1].safe.remoteControlConnectionsEnabled, true);
  for (const platform of ["Mac", "Linux"]) {
    const x = runtime(owner, { platform, gate: "native-result" }); x.render(); x.effects[0].effect();
    assert.equal(x.calls[0].enabled, "native-result");
  }
});

test("coherent owner/provider/caller captures, eager writes and noncanonical contributions reject", () => {
  const c = snapshot();
  const collision = change(change(c, "function p5()", "function c()"), "(p5,{})", "(c,{})");
  const cases = [
    collision,
    change(c, 'let e=t4.appServices.remoteConnections;', 'let t4=t4.appServices.remoteConnections;'),
    change(c, '.catch(e=>{v.v.warning', '.catch(l=>{v.v.warning').moduleSource.replace('sensitive:{error:e}', 'sensitive:{error:l}'),
    change(c, '(p9,{})', '(Unused,{})'),
    { ...c, params: ["navigator", "t", "n"] },
    { ...c, moduleSource: c.moduleSource + ";eg=other;" },
    { ...c, moduleSource: c.moduleSource + `/*${MARKER}*/` },
  ];
  for (const bad of cases) assert.throws(() => prepareBridgeOwner(typeof bad === "string" ? { ...c, moduleSource: bad } : bad));
  const p = prepareBridgeOwner(c);
  assert.throws(() => prepareBridgeOwner(change({ ...c, moduleSource: p.patchedSource }, "navigator.userAgent.includes(`Linux`)", "true")));
});

test("wrong facade setter and changed gate publication/Statsig result are read-only qualification failures", () => {
  assert.throws(() => inspectAppServicesFacade(change(fixture.facades[0], 'o=e', 't=e')));
  assert.throws(() => inspectPairingGate(change({ ...fixture.pairing, start: 0 }, 'f="2055603567"', 'f="wrong"'), "Qg"));
  assert.throws(() => inspectNativeGateHook(change({ ...fixture.hook, start: 0 }, 'return f(),(0,i.useStatsigClient)()', 'return f(),false'), "cn"));
});

// A later same-scope function declaration replaces the native binding even
// when the inspected earlier function still has every original anchor.
test("duplicate native owner, parent or render declarations cannot replace the qualified live binding", () => {
  const native = snapshot();
  for (const name of ["p9", "p5", "gF"]) {
    const bad = { ...native, moduleSource: native.moduleSource + `function ${name}(){return null}` };
    assert.throws(() => prepareBridgeOwner(bad), /native owner\/caller\/render binding/);
  }
});

test("native render declaration cannot capture a factory loader parameter", () => {
  const bad = change(snapshot(), "function gF(e)", "function n(e)");
  assert.throws(() => prepareBridgeOwner(bad), /native owner\/caller\/render binding/);
});

test("all critical root heads reject later complex-parameter, generator and commented declarations", () => {
  const c = snapshot();
  for (const name of ["p9", "p5", "gF"]) for (const declaration of [
    `function ${name}(unused=()=>{}){return null}`,
    `function* ${name}(){return null}`,
    `function /* head */ * /* name */ ${name}(){return null}`,
  ]) assert.throws(() => prepareBridgeOwner({ ...c, moduleSource: c.moduleSource + declaration }), /native owner\/caller\/render binding/);
});

test("native gate hook and context helper cannot be replaced by uninventoried function forms", () => {
  for (const name of ["u", "f"]) for (const declaration of [
    `function ${name}(unused=()=>{}){return null}`,
    `function* ${name}(){return null}`,
    `function /* head */ ${name}(unused=()=>{}){return null}`,
  ]) assert.throws(() => inspectNativeGateHook({ ...fixture.hook, start: 0, moduleSource: fixture.hook.moduleSource + declaration }, "cn"));
});
