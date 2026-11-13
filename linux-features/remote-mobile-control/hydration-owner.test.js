"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const data = require("./hydration-contract-data.json");
const { createHarness, selectLifecycle } = require("./hydration-harness.js");
const { prepareHydrationLifecycle } = require("./hydration-owner.js");

// Root's complete-owner source tests separately prove this emitted lifecycle's
// publication and physical asset ownership. This suite exercises only its finite
// native discovery/queue callbacks under controlled manager/store dependencies.
const patchedLifecycle = () => selectLifecycle(prepareHydrationLifecycle(data.life).patchedSource);
const harness = options => createHarness({ lifeSource: patchedLifecycle(), ...options });
const plain = value => JSON.parse(JSON.stringify(value));

test("literal-local discovers each owned event while cloud and other hosts retain native gates", () => {
  for (const hostId of ["local", "remote-ssh:box", "remote-control:box", "other-host"]) {
    for (const isCloudHost of [false, true]) for (const method of ["turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "thread/status/changed"]) {
      const h = harness({ hostId, isCloudHost });
      const expected = (isCloudHost && method.startsWith("turn/")) || hostId === "local" && ["turn/started", "turn/completed", "item/started", "item/completed"].includes(method);
      assert.equal(h.queue(h.notification(method)), expected, JSON.stringify({ hostId, isCloudHost, method }));
      assert.equal(h.hydrations.length, expected ? 1 : 0);
      h.lifecycle.clear();
    }
  }
});

test("one hydrate owns an ordered notification queue with original timestamps, capabilities and ignore callbacks", async () => {
  const h = harness(), capability = { threadId: "thread-a", turnId: "turn-a" }, ignore = () => false;
  const events = [
    h.notification("turn/started", "thread-a", { turn: { id: "turn-a" } }, { receivedAtMs: 51, automationCapability: capability }),
    h.notification("item/started", "thread-a", { turnId: "turn-a", item: { id: "item-a", type: "commandExecution" } }, { receivedAtMs: 52 }),
    h.notification("item/completed", "thread-a", { turnId: "turn-a", item: { id: "item-a", type: "commandExecution" } }, { receivedAtMs: 53 }),
    h.notification("turn/completed", "thread-a", { turn: { id: "turn-a" } }, { receivedAtMs: 54 }),
  ];
  for (const event of events) assert.equal(h.queue(event, ignore), true);
  assert.equal(h.hydrations.length, 1);
  h.complete(0); await h.flush();
  assert.deepEqual(h.notifications.map(row => row.method), events.map(row => row.notification.method));
  assert.deepEqual(h.notifications.map(row => row.receivedAtMs), [51, 52, 53, 54]);
  assert.equal(h.notifications[0].automationCapability, capability);
  for (let i = 0; i < events.length; i++) { assert.equal(h.notifications[i].params, events[i].notification.params); assert.equal(h.notifications[i].shouldIgnore, ignore); }
  assert.equal(h.lifecycle.pending.size, 0);
  assert.equal(h.lifecycle.buffer.buffers.size, 0);
});

test("duplicate notices reuse discovery and retain the native duplicate replay policy", async () => {
  const h = harness(), event = h.notification("turn/started", "thread-a", { turn: { id: "turn-a" } });
  assert.equal(h.queue(event), true); assert.equal(h.queue(event), true);
  assert.equal(h.hydrations.length, 1);
  h.complete(0); await h.flush();
  assert.equal(h.notifications.length, 2, "the feature must not invent a new notification deduplication policy");
  assert.equal(h.notifications[0].params, event.notification.params); assert.equal(h.notifications[1].params, event.notification.params);
});

test("completed-first agent messages retain queue order and suppress redundant buffered text deltas", async () => {
  const h = harness(), item = { id: "answer", type: "agentMessage", text: "finished answer" };
  h.queue(h.notification("item/completed", "thread-a", { turnId: "turn-a", item }));
  h.queue(h.notification("item/agentMessage/delta", "thread-a", { turnId: "turn-a", itemId: "answer", delta: "finished answer" }));
  h.queue(h.notification("turn/completed", "thread-a", { turn: { id: "turn-a" } }));
  h.complete(0, { turns: [{ turnId: "turn-a", items: [item] }] }); await h.flush();
  assert.deepEqual(h.notifications.map(row => row.method), ["item/completed", "turn/completed"]);
  assert.equal(h.notifications[0].params.item, item);
});

test("hydrated text fills a started item and trims only its buffered hydrated prefix", async () => {
  const h = harness();
  h.queue(h.notification("item/started", "thread-a", { turnId: "turn-a", item: { id: "answer", type: "agentMessage", text: "" } }));
  h.queue(h.notification("item/agentMessage/delta", "thread-a", { turnId: "turn-a", itemId: "answer", delta: "hello" }));
  h.queue(h.notification("item/commandExecution/outputDelta", "thread-a", { turnId: "turn-a", itemId: "command", delta: "done!" }));
  h.complete(0, { turns: [{ turnId: "turn-a", items: [
    { id: "answer", type: "agentMessage", text: "hello" },
    { id: "command", type: "commandExecution", aggregatedOutput: "done!" },
  ] }] }); await h.flush();
  assert.deepEqual(h.notifications.map(row => row.method), ["item/started"]);
  assert.equal(h.notifications[0].params.item.text, "hello");
});

test("unresolved requests replay by identity while a queued resolution completes its request without replay", async () => {
  const h = harness(), first = { id: "open-request", method: "test/request", params: { threadId: "thread-a" } }, second = { id: "resolved-request", method: "test/request", params: { threadId: "thread-a" } };
  assert.equal(h.request(first), true); assert.equal(h.request(second), true);
  h.queue(h.notification("serverRequest/resolved", "thread-a", { requestId: second.id }));
  h.complete(0, { requests: [first, second] }); await h.flush();
  assert.equal(h.hydrations.length, 1); assert.deepEqual(h.requests, [first]);
  assert.deepEqual(h.conversations.get("thread-a").requests, [first]);
  assert.deepEqual(h.updates, ["thread-a"]);
  assert.deepEqual(h.notifications.map(row => row.method), ["serverRequest/resolved"]);
});

test("known, suppressed, malformed and retired notifications cannot start discovery", () => {
  const h = harness({ known: ["known"], suppressed: ["hidden"] });
  for (const id of ["known", "hidden"]) assert.equal(h.queue(h.notification("item/started", id)), false);
  for (const params of [{}, { threadId: "" }, { threadId: 42 }, { thread: [] }, { thread: { id: "" } }]) assert.equal(h.queue({ notification: { method: "item/started", params } }), false);
  assert.equal(h.queue(h.notification("thread/archived")), false); assert.equal(h.queue(h.notification("thread/deleted")), false);
  assert.equal(h.hydrations.length, 0);
  assert.equal(h.queue({ notification: { method: "turn/completed", params: { thread: { id: "nested-id" }, turn: { id: "turn-a" } } } }), true);
  assert.equal(h.hydrations[0].id, "nested-id"); h.lifecycle.clear();
});

test("a failed hydrate retries once at the native delay and a second miss discards its queue", async () => {
  const h = harness(); h.queue(h.notification("item/started"));
  h.hydrations[0].resolve(false); await h.flush();
  assert.equal(h.scheduled.length, 1); assert.equal(h.scheduled[0].delay, 1000);
  assert.equal(h.lifecycle.pending.size, 1); assert.equal(h.notifications.length, 0);
  h.runRetry(); assert.equal(h.hydrations.length, 2);
  h.hydrations[1].resolve(false); await h.flush();
  assert.equal(h.scheduled[0].cancelled, true); assert.equal(h.scheduled.length, 1);
  assert.equal(h.lifecycle.pending.size, 0); assert.equal(h.lifecycle.buffer.buffers.size, 0); assert.equal(h.notifications.length, 0);
});

test("retry success releases the original queue, whereas clear cancels a scheduled retry", async () => {
  const h = harness(); h.queue(h.notification("item/started", "thread-a", { item: { type: "commandExecution" } }));
  h.hydrations[0].resolve(false); await h.flush(); h.runRetry(); h.complete(1); await h.flush();
  assert.equal(h.notifications.length, 1); assert.equal(h.lifecycle.pending.size, 0);
  const cancelled = harness(); cancelled.queue(cancelled.notification("turn/completed"));
  cancelled.hydrations[0].resolve(false); await cancelled.flush(); cancelled.lifecycle.clear();
  assert.equal(cancelled.scheduled[0].cancelled, true); assert.equal(cancelled.lifecycle.pending.size, 0); assert.equal(cancelled.lifecycle.buffer.buffers.size, 0);
});

test("hydrate rejection logs the native failure and releases pending state without replay", async () => {
  const h = harness(), failure = Error("controlled hydrate failure"); h.queue(h.notification("item/started"));
  h.hydrations[0].reject(failure); await h.flush();
  assert.equal(h.logs.length, 1); assert.equal(h.logs[0].message, "Failed to discover thread from event");
  assert.equal(h.logs[0].fields.sensitive.error, failure); assert.equal(h.logs[0].fields.sensitive.conversationId, "thread-a");
  assert.equal(h.lifecycle.pending.size, 0); assert.equal(h.lifecycle.buffer.buffers.size, 0); assert.equal(h.notifications.length, 0); assert.equal(h.scheduled.length, 0);
});

test("ignore callbacks, suppression and discarded generations fence late hydrate completions", async () => {
  const ignored = harness(); assert.equal(ignored.queue(ignored.notification("item/started"), () => true), false);
  assert.equal(ignored.hydrations.length, 0); assert.equal(ignored.lifecycle.pending.size, 0);
  const h = harness(); let ignore = false; const shouldIgnore = () => ignore;
  h.queue(h.notification("item/started"), shouldIgnore); assert.equal(h.hydrations[0].current(), true);
  ignore = true; assert.equal(h.hydrations[0].current(), false); h.complete(0); await h.flush();
  assert.equal(h.notifications.length, 0); assert.equal(h.lifecycle.pending.size, 0);
  const hidden = harness(); hidden.queue(hidden.notification("item/started")); hidden.hidden.add("thread-a");
  assert.equal(hidden.hydrations[0].current(), false); hidden.complete(0); await hidden.flush(); assert.equal(hidden.notifications.length, 0);
  const generations = harness(); generations.queue(generations.notification("item/started")); generations.lifecycle.discard("thread-a");
  assert.equal(generations.hydrations[0].current(), false);
  generations.queue(generations.notification("item/completed", "thread-a", { item: { type: "commandExecution" } }));
  generations.complete(0); await generations.flush(); assert.equal(generations.notifications.length, 0); assert.equal(generations.lifecycle.pending.size, 1);
  generations.complete(1); await generations.flush(); assert.deepEqual(generations.notifications.map(row => row.method), ["item/completed"]);
});

test("different pending threads and different host-owned lifecycles cannot release each other's queues", async () => {
  const h = harness(); h.queue(h.notification("item/started", "thread-a", { item: { type: "commandExecution" } })); h.queue(h.notification("turn/completed", "thread-b"));
  h.complete(1); await h.flush(); assert.deepEqual(h.notifications.map(row => row.params.threadId), ["thread-b"]);
  assert.equal(h.lifecycle.pending.has("thread-a"), true); h.complete(0); await h.flush();
  assert.deepEqual(h.notifications.map(row => row.params.threadId), ["thread-b", "thread-a"]);
  const first = harness(), second = harness(); first.queue(first.notification("turn/started")); second.queue(second.notification("turn/completed"));
  first.complete(0); await first.flush(); assert.equal(first.notifications.length, 1); assert.equal(second.notifications.length, 0);
  second.lifecycle.clear(); second.complete(0); await second.flush(); assert.equal(second.notifications.length, 0);
});

test("canonical hydration forwards its existing merge policy while dynamic tool request gates remain native", async () => {
  const policy = { mode: "existing-policy" }, h = harness({ mergePolicy: policy });
  const canonical = [{ turnId: "past", items: [] }], live = [{ turnId: "current", items: [] }];
  assert.equal(h.request({ id: "setup", method: "item/tool/requestSetupCodexContextPicker", params: { threadId: "thread-a" } }), false);
  assert.equal(h.request({ id: "done-tool", method: "item/tool/call", params: { threadId: "thread-a", status: "completed" } }), false);
  assert.equal(h.request({ id: "bad-elicitation", method: "mcpServer/elicitation/request", params: { threadId: "thread-a", invalid: true } }), false);
  assert.equal(h.hydrations.length, 0);
  const history = { islands: [{ entries: [{ value: "past" }] }], entitiesByKey: { past: canonical[0] } };
  h.queue(h.notification("turn/completed")); h.complete(0, { turnHistory: { kind: "canonical", history }, turns: live }); await h.flush();
  assert.equal(h.merges.length, 1); assert.deepEqual(h.merges[0].canonical, canonical); assert.equal(h.merges[0].canonical[0], canonical[0]); assert.equal(h.merges[0].live, live); assert.equal(h.merges[0].options.policy, policy);
  assert.equal(h.parserCalls[0].kind, "dynamic-tool"); assert.equal(h.parserCalls[1].kind, "elicitation"); assert.equal(h.parserCalls[1].enabled, true);
  assert.deepEqual(plain(h.notifications.map(row => row.method)), ["turn/completed"]);
});


test("current local resolution traversal visits canonical entities and flat turns with native missing-entity handling", () => {
  const resolve = vm.runInNewContext(data.readCanonicalHistory + data.visitTurns + ";(" + data.resolved + ")", {
    g: { J: value => value, D: value => value },
  });
  for (const canonical of [false, true]) {
    const matched = { type: "mcpServerElicitation", requestId: "done", completed: false };
    const other = { type: "mcpServerElicitation", requestId: "other", completed: false };
    const live = { type: "mcpServerElicitation", requestId: "done", completed: false };
    const stored = { items: [matched, other] }, conversation = { requests: [], turns: [canonical ? { items: [live] } : stored] };
    if (canonical) conversation.turnHistory = {
      kind: "canonical",
      history: { islands: [{ entries: [{ value: "missing" }, { value: "present" }] }], entitiesByKey: { present: stored } },
    };
    const manager = {
      getConversation: () => conversation,
      updateConversationState(threadId, update) { assert.equal(threadId, "thread-a"); update(conversation); },
    };
    resolve(manager, { params: { threadId: "thread-a", requestId: "done" } });
    assert.equal(matched.completed, true);
    assert.equal(other.completed, false);
    assert.equal(live.completed, false);
    assert.deepEqual(plain(conversation.requests), []);
  }
});
