"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const { NATIVE_TRACE_MARKER, patchNativeSenderTrace, traceRuntimeSource } = require("./patches/selected-text-more-details-trace.js");

function traceFixture(logger) {
  const logs = [];
  const context = vm.createContext({ logger: logger ?? { info(message, fields) { logs.push(fields.safe); } } });
  vm.runInContext(traceRuntimeSource(), context);
  const trace = vm.runInContext("codexLinuxQuickChatCreateTrace(logger)", context);
  return { context, trace, logs };
}

test("native trace callbacks preserve ordinary requests, receivers, return values, and thrown errors", () => {
  const f = traceFixture();
  const receiver = { calls: [] };
  const callback = function(value) { this.calls.push(value); return 17; };
  assert.equal(f.context.codexLinuxQuickChatTraceCallback(undefined, "request-start", callback), callback);
  const wrapped = f.context.codexLinuxQuickChatTraceCallback(f.trace, "request-start", callback);
  assert.equal(wrapped.call(receiver, "argument"), 17);
  assert.deepEqual(receiver.calls, ["argument"]);
  assert.equal(f.logs[0].phase, "request-start");
  const error = new Error("native callback failed");
  const throwing = f.context.codexLinuxQuickChatTraceCallback(f.trace, "request-start", () => { throw error; });
  assert.throws(throwing, (observed) => observed === error);
  const broken = traceFixture({ info() { throw new Error("logger unavailable"); } });
  assert.equal(broken.context.codexLinuxQuickChatTraceCallback(broken.trace, "request-start", callback).call(receiver, 1), 17);
});

test("timing logs allow only measured scalars and fixed enums, and never copy tokens, content, headers, or identifiers", () => {
  const f = traceFixture();
  const privateValue = "private-value-must-not-appear";
  f.trace.callback("timing", { type: "integrity_prepare", durationMs: 112.2, headers: { authorization: privateValue }, token: privateValue });
  f.trace.callback("timing", { type: privateValue, durationMs: 5 });
  f.trace.callback("response-headers", { status: 200, isEventStream: true, headers: { "x-request-id": privateValue } });
  f.trace.callback("stream-error", { error: privateValue, errorCode: privateValue, responseStatus: 502, requestId: privateValue });
  f.trace.event("native-stream-create", { cacheStatus: privateValue, prepareState: "success", requestId: privateValue });
  assert.equal(f.logs.length, 4);
  assert.equal(f.logs[0].timingType, "integrity_prepare");
  assert.equal(f.logs[0].durationMs, 112);
  assert.equal(f.logs[1].httpStatus, 200);
  assert.equal(f.logs[2].errorCodePresent, true);
  assert.equal(f.logs[3].prepareState, "success");
  assert.equal(JSON.stringify(f.logs).includes(privateValue), false);
  assert.ok(f.logs.every((log) => Number.isSafeInteger(log.traceNo) && log.elapsedMs >= 0));
});

test("stream chunk and model-message logging stays bounded while later callbacks continue to run", () => {
  const f = traceFixture();
  let calls = 0;
  const wrapped = f.context.codexLinuxQuickChatTraceCallback(f.trace, "stream-data", () => calls++);
  for (let i = 0; i < 1000; i++) wrapped({ eventBytes: i + 10, eventCount: 1 });
  f.trace.modelMessage({ author: { role: "user" }, channel: "analysis", content: "private" });
  for (let i = 0; i < 1000; i++) f.trace.modelMessage({ author: { role: "assistant" }, channel: "analysis", content: "private" });
  assert.equal(calls, 1000);
  assert.deepEqual(f.logs.map((log) => log.phase), ["stream-data-first", "model-message-first"]);
  for (let i = 0; i < 1000; i++) f.trace.callback("timing", { type: "stream_post", durationMs: i });
  assert.equal(f.logs.filter((log) => log.phase === "native-timing").length, 4);
});

test("trace registry cleanup cannot remove a newer request and captured stream callbacks remain usable", () => {
  const f = traceFixture();
  const scope = {};
  const old = f.trace;
  const next = vm.runInContext("codexLinuxQuickChatCreateTrace(logger)", f.context);
  const oldRelease = f.context.codexLinuxQuickChatAttachTrace(scope, "conversation", old);
  const nextRelease = f.context.codexLinuxQuickChatAttachTrace(scope, "conversation", next);
  oldRelease();
  assert.equal(f.context.codexLinuxQuickChatTraceFor(scope, "conversation"), next);
  nextRelease();
  assert.equal(f.context.codexLinuxQuickChatTraceFor(scope, "conversation"), undefined);
  const recreatedRelease = f.context.codexLinuxQuickChatAttachTrace(scope, "conversation", next);
  oldRelease();
  assert.equal(f.context.codexLinuxQuickChatTraceFor(scope, "conversation"), next);
  recreatedRelease();
  old.callback("stream-complete", { reason: "done" });
  assert.equal(f.logs.at(-1).phase, "stream-complete");
});

function nativeFixture() {
  return 'async function Sender(scope,input){let overrides=input.gizmoEditor??scope.get(settings,input.conversationId),cache={cacheStatus:`missing`,clientPrepareState:`none`,inFlightPrepared:null},first=input.first,recovered=input.recovered;if(first)overrides.onModelMessage(first.message);if(recovered)overrides.onModelMessage(recovered);let result=await scope.get(service).startCompletionStream({assertRequestCurrent:()=>{},onPrepareRequestStart:()=>{},onRequestStart:()=>{},onResponse:response=>{},onTiming:timing=>{},onStreamData:overrides.onStreamData,onComplete:()=>{},onTransportClose:()=>{},onError:failed,onRecoverableError:failed,inFlightPrepared:cache.inFlightPrepared,request:input});return result}';
}

test("native tracing is complete and idempotent and rejects partial callback drift", () => {
  const source = nativeFixture();
  const result = patchNativeSenderTrace({ name: "Sender", source });
  assert.equal(result.applied, false);
  assert.equal(result.source.split(NATIVE_TRACE_MARKER).length, 2);
  assert.equal(patchNativeSenderTrace({ name: "Sender", source: result.source }).source, result.source);
  assert.equal(patchNativeSenderTrace({ name: "Sender", source: result.source }).applied, true);
  assert.throws(() => patchNativeSenderTrace({ name: "Sender", source: source.replace("onTiming:timing", "onTimingChanged:timing") }), /Missing native onTiming/);
  assert.throws(() => patchNativeSenderTrace({ name: "Sender", source: result.source.replace('"response-headers"', '"wrong-stage"') }), /Incomplete native onResponse/);
});

test("patched sender associates callbacks only with the selected trace and preserves native dispatch", async () => {
  const result = patchNativeSenderTrace({ name: "Sender", source: nativeFixture() });
  const f = traceFixture();
  let captured;
  const native = { onStreamData() { return "native"; }, onModelMessage() {} };
  const scope = { get(atom) { return atom === "settings" ? native : { async startCompletionStream(options) { captured = options; return "dispatched"; } }; } };
  Object.assign(f.context, { settings: "settings", service: "service", failed() {} });
  vm.runInContext(result.source, f.context);
  const release = f.context.codexLinuxQuickChatAttachTrace(scope, "selected", f.trace);
  assert.equal(await f.context.Sender(scope, { conversationId: "selected" }), "dispatched");
  captured.onRequestStart();
  captured.onTiming({ type: "conversation_prepare", durationMs: 3 });
  assert.equal(captured.onStreamData({ eventBytes: 1, eventCount: 1 }), "native");
  assert.deepEqual(f.logs.map((log) => log.phase), ["native-sender-entered", "native-stream-create", "request-start", "native-timing", "stream-data-first"]);
  release();
  const before = f.logs.length;
  assert.equal(await f.context.Sender(scope, { conversationId: "ordinary" }), "dispatched");
  captured.onRequestStart();
  captured.onTiming({ type: "integrity_prepare", durationMs: 1 });
  assert.equal(f.logs.length, before);
});
