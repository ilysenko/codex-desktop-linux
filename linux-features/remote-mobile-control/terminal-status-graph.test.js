"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const f = require("./fixtures/current-terminal-status-graph.json"), graph = require("./terminal-status-graph.js");
function copy(id) { return { ...f.modules.find(x => x.moduleId === id), start: 0 }; }
function change(c, from, to) { assert.equal(c.moduleSource.split(from).length, 2);return { ...c, moduleSource: c.moduleSource.replace(from, to) }; }
function providers() { return { threadState: [copy("tl5a")], runtimeState: [copy("XQr6")], hostSelector: [copy("Bl6U")] }; }

test("actual readonly providers preserve native host/thread keys and summary/runtime/request links", () => {
  const p = graph.inspectTerminalStateProviders(providers(), "tl5a");
  assert.deepEqual(p, { threadStateId: "tl5a", runtimeId: "XQr6", selectorId: "Bl6U" });
});
test("summary projection and its actual root key function cannot exchange hosts and threads", () => {
  assert.throws(() => graph.inspectThreadState(change(copy("tl5a"), "hostId:e.hostId,threadId:e.conversationId", "hostId:e.conversationId,threadId:e.hostId")));
  assert.throws(() => graph.inspectThreadState(change(copy("tl5a"), 'return`${e}:${t}`', 'return`${t}:${e}`')));
  assert.throws(() => graph.inspectThreadState({ ...copy("tl5a"), moduleSource: copy("tl5a").moduleSource + ';function* Z(){return null}' }));
});
test("summary atom must initialize a real root declarator and retain its provider authority", () => {
  const native = copy("tl5a");
  const init = 'ef=(0,a.i1)(B.u,(e,{get:t})=>t(T.Nb,{hostId:e.hostId,threadId:e.conversationId}),{isEqual:i(),key:Z})';
  assert.throws(() => graph.inspectThreadState(change(native, init, 'ef=void 0;if(false)' + init)));
  assert.throws(() => graph.inspectThreadState({ ...native, moduleSource: native.moduleSource + ';ef=other;' }));
  assert.throws(() => graph.inspectThreadState(change(native, "ok:()=>T.ok", "ok:()=>C.ok")));
});
test("actual root atom declaration cannot become an unreachable function-scoped var statement", () => {
  assert.throws(() => graph.inspectThreadState(change(copy("tl5a"), 'let eu=', 'if(false)var eu=')), /changed native root declaration kind/);
});
test("per-thread subscription and thread host selection remain native readonly interfaces", () => {
  assert.throws(() => graph.inspectRuntimeState(change(copy("XQr6"), 'type:"thread",key:t,field:"listState"', 'type:"host",key:t,field:"listState"')));
  assert.throws(() => graph.inspectHostSelector(change(copy("Bl6U"), 'n?.has("local")?"local"', 'n?.has("other")?"other"'), "XQr6"));
  const all = providers();all.runtimeState.push(change(copy("XQr6"), 'type:"thread",key:t,field:"listState"', 'type:"host",key:t,field:"listState"'));
  assert.throws(() => graph.inspectTerminalStateProviders(all, "tl5a"));
  assert.throws(() => graph.inspectThreadState({ ...copy("tl5a"), moduleSource: copy("tl5a").moduleSource + '/*' + 'x'.repeat(32 * 1024) + '*/' }));
});
