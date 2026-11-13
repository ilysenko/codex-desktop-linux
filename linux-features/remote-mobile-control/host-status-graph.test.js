"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fixture = require("./fixtures/current-host-status-graph.json"), graph = require("./host-status-graph.js");
function copy(id) { const row = fixture.modules.find(x => x.moduleId === id);assert.ok(row, id);return { ...row, start: 0 }; }
function change(c, before, after) { assert.equal(c.moduleSource.split(before).length, 2, "coherent mutation hits one real native span");return { ...c, moduleSource: c.moduleSource.replace(before, after) }; }

test("native classifier is exactly durable and linked native per-host lifecycle remains source-qualified", () => {
  const bridge = graph.inspectClassifierBridge(copy("dbK8"), "C"), facade = graph.inspectClassifierFacade(copy(bridge.facade.moduleId), bridge.exportName);
  assert.equal(graph.inspectDurableLiteral(copy(facade.literalModule.moduleId), facade.exportName).hostId, "durable");
  assert.equal(graph.inspectNativeAwaiter(copy("q77y"), "P").exportName, "P");
  const manager = graph.inspectNativeManager(copy("hms3")), lifecycle = graph.inspectReadLifecycle(copy(manager.subscriber.moduleId), "ihPm");
  assert.equal(manager.facade.moduleId, "GaA7");assert.equal(manager.classifierFacade.moduleId, facade.moduleId);
  assert.equal(lifecycle.nativeFunctionBytes, 66233);assert.equal(lifecycle.status.moduleId, "ihPm");
  assert.deepEqual(lifecycle.mount, { host: "t", client: "i", current: "A", disposer: "nQ" });
  assert.equal(lifecycle.prefixProviders.AP.moduleId, "ihPm");assert.equal(lifecycle.prefixProviders.v.moduleId, "WFY2");
  assert.throws(() => { manager.facade.moduleId = "wrong"; }, TypeError);
  assert.throws(() => { lifecycle.mount.host = "other"; }, TypeError);
});

test("wrong classifier member, literal and captured bridge function reject without executing providers", () => {
  const facade = graph.inspectClassifierFacade(change(copy("DBCl"), "ZJQ:()=>ei.ZJ", "ZJQ:()=>ei.Other"), "ZJQ");
  assert.throws(() => graph.inspectDurableLiteral(copy(facade.literalModule.moduleId), facade.exportName));
});

test("classifier host equality and bridge factory authority are preserved", () => {
  assert.throws(() => graph.inspectDurableLiteral(change(copy("N2rm"), 'r="durable"', 'r="cloud"'), "ZJ"));
  assert.throws(() => graph.inspectDurableLiteral(change(copy("N2rm"), "ZJ:function(e){return e===r}", "ZJ:function(r){return r===r}"), "ZJ"));
  let c = change(copy("dbK8"), "function i(e)", "function n(e)");c = change(c, "C:i", "C:n");c = change(c, "return i(e)?", "return n(e)?");
  assert.throws(() => graph.inspectClassifierBridge(c, "C"));
});

test("native await/dispose and per-host manager identity cannot be replaced by matching strings", () => {
  assert.throws(() => graph.inspectNativeAwaiter(change(copy("q77y"), ',i()}}})', ',void 0}}})'), "P"));
  assert.throws(() => graph.inspectNativeManager(change(copy("hms3"), "A.connection===x", "A.connection===null")));
  assert.throws(() => graph.inspectNativeManager({ ...copy("hms3"), moduleSource: copy("hms3").moduleSource + "/*" + "x".repeat(16 * 1024) + "*/" }));
});

test("published subscriber root heads include complex defaults and generators", () => {
  for (const decl of ['function nz(unused=()=>{}){return null}', 'function* nz(){return null}', 'function /* head */ * nz(){return null}']) {
    const c = copy("J8Ro");assert.throws(() => graph.inspectReadLifecycle({ ...c, moduleSource: c.moduleSource + decl }, "ihPm"));
  }
  let c = change(copy("J8Ro"), "x:()=>nz", "x:()=>n");c = change(c, "function nz(e,t,i,A)", "function n(e,t,i,A)");
  assert.throws(() => graph.inspectReadLifecycle(c, "ihPm"));
});

test("wrong host, skipped disposer and changed bounded mount prefix reject", () => {
  assert.throws(() => graph.inspectReadLifecycle(change(copy("J8Ro"), "let nQ=(0,eY.UL)(e,t,i,A)", 'let nQ=(0,eY.UL)(e,"other",i,A)'), "ihPm"));
  assert.throws(() => graph.inspectReadLifecycle(change(copy("J8Ro"), "nQ()", "void 0"), "ihPm"));
  assert.throws(() => graph.inspectReadLifecycle(change(copy("J8Ro"), "let nQ=(0,eY.UL)", "!function(){i=other}();let nQ=(0,eY.UL)"), "ihPm"));
  assert.throws(() => graph.inspectReadLifecycle({ ...copy("J8Ro"), moduleSource: copy("J8Ro").moduleSource + ";eK=new WeakSet;" }, "ihPm"));
});

test("native WeakSet and durable values must initialize their actual root let declarators", () => {
  const scope = change(copy("J8Ro"), "let eK=new WeakSet;", "let eK;if(false)eK=new WeakSet;");
  assert.throws(() => graph.inspectReadLifecycle(scope, "ihPm"), /WeakSet let-declarator/);
  const literal = change(copy("N2rm"), 'let r="durable",a=', 'let r;if(false)r="durable";let a=');
  assert.throws(() => graph.inspectDurableLiteral(literal, "ZJ"), /durable let-declarator/);
});

test("native Map constructors and Math retry arithmetic are literal intrinsics, not alpha aliases", () => {
  const c = copy("hms3");assert.equal(c.moduleSource.split("new Map").length, 3);
  assert.throws(() => graph.inspectNativeManager({ ...c, moduleSource: c.moduleSource.replaceAll("new Map", "new WeakMap") }));
  assert.throws(() => graph.inspectNativeManager(change(c, "Math.min", "WeakMap.min")));
});


test("current larger subscriber preserves its queued-work cancellation and bounded mount prefix", () => {
  const c = copy("J8Ro"), lifecycle = graph.inspectReadLifecycle(c, "ihPm");
  assert.ok(lifecycle.nativeFunctionBytes > 64 * 1024);
  assert.ok(lifecycle.nativeFunctionBytes < 96 * 1024);
  assert.throws(() => graph.inspectReadLifecycle(change(c, "ru.cancel()", "ru.dispose()"), "ihPm"), /cleanup/);
  assert.throws(() => graph.inspectReadLifecycle(change(c, "var S,b,w,O,L;let U,", "var S,b,w,O,L;let obsolete,U,"), "ihPm"), /prefix/);
  assert.throws(() => graph.inspectReadLifecycle({ ...c, moduleSource: c.moduleSource + "/*" + "x".repeat(96 * 1024) + "*/" }, "ihPm"), /bounded/);
});
