"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/current-host-toggle.json");
const graph = require("./host-toggle-graph.js");
const get = id => fixture.modules.find(row => row.moduleId === id);

test("actual small native providers and public toggle caller retain selected-host links", () => {
  const client = graph.inspectSelectedHostClient(get("Dgwo"), "V");
  assert.equal(client.host, "t");
  assert.equal(client.connectionSource.moduleId, "l00C");
  const status = graph.inspectHostStatusPublication(get("ihPm"), "AP", "Lt");
  assert.equal(status.atom, "u");
  assert.equal(status.mapper, "p");
  const caller = graph.inspectHostToggleCaller(get("UIre"), "WbV5", "p", "ihPm");
  assert.equal(caller.target.moduleId, "WbV5");
  assert.equal(caller.waitExport, "Hf");
  assert.equal(caller.overrideExport, "UV");
});

test("client provider wrong host, publication and deferred-watch host cannot qualify", () => {
  const row = get("Dgwo"), mutate = code => ({ ...row, moduleSource: code });
  assert.throws(() => graph.inspectSelectedHostClient(row, "unrelated"));
  for (const code of [row.moduleSource.replace("p.forHost(t)", 'p.forHost("other")'),
    row.moduleSource.replace("n(o.M4,t)", 'n(o.M4,"other")'), `/*${row.moduleSource}*/`]) {
    assert.throws(() => graph.inspectSelectedHostClient(mutate(code), "V"));
  }
});

test("native mapper and public caller reject wrong atom, wrong fallback and captured intrinsic", () => {
  const status = get("ihPm"), caller = get("UIre");
  assert.throws(() => graph.inspectHostStatusPublication(status, "Zg", "Lt"));
  assert.throws(() => graph.inspectHostStatusPublication({ ...status,
    moduleSource: status.moduleSource.replace("e.set(u,t,n)", 'e.set(u,"other",n)') }, "AP", "Lt"));
  assert.throws(() => graph.inspectHostToggleCaller(caller, "wrong-native-module", "p", "ihPm"));
  assert.throws(() => graph.inspectHostToggleCaller({ ...caller,
    moduleSource: caller.moduleSource.replace("(0,c.p)(e,r,t)", '(0,c.p)(e,"other",t)') }, "WbV5", "p", "ihPm"));
  assert.throws(() => graph.inspectHostToggleCaller({ ...caller, params: ["Promise", "r", "t"] }, "WbV5", "p", "ihPm"));
});

test("the native public caller helper cannot collide with its rooted fallback import", () => {
  const row = get("UIre");
  const source = row.moduleSource.replace("async function a(", "async function c(")
    .replace("return a(", "return c(").replace("let t=a(", "let t=c(")
    .replace("let c=(0,l.Hf)", "let w=(0,l.Hf)")
    .replace("[c,t.then(()=>c)]", "[w,t.then(()=>w)]");
  assert.throws(() => graph.inspectHostToggleCaller({ ...row, moduleSource: source }, "WbV5", "p", "ihPm"), /captured/);
});
