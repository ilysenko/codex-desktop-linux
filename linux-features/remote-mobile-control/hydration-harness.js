"use strict";

// Execute only the finite discovery/notification queue capsules. The published
// app-server manager, module factory and transport never run in this harness.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const data = require("./hydration-contract-data.json");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

function selectLifecycle(source) {
  const logger = source.indexOf("Failed to discover thread from event");
  assert.ok(logger >= 0);
  const start = source.lastIndexOf("class ", logger);
  assert.ok(start >= 0);
  const end = findMatchingBrace(source, source.indexOf("{", start));
  assert.ok(end > logger);
  return source.slice(start, end + 1);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createHarness({
  lifeSource = data.life,
  hostId = "local",
  isCloudHost = false,
  known = [],
  suppressed = [],
  mergePolicy = { source: "controlled-native-merge-policy" },
} = {}) {
  const conversations = new Map(known.map(id => [id, { id, turns: [], requests: [] }]));
  const hidden = new Set(suppressed);
  const hydrations = [], scheduled = [], notifications = [], requests = [], updates = [], logs = [], merges = [], parserCalls = [];
  const context = {
    threadStore: {
      conversations,
      isConversationSuppressed: id => hidden.has(id),
      hydrateActiveThread(id, current) {
        const task = deferred();
        hydrations.push({ id, current, ...task });
        return task.promise;
      },
    },
    turnMergePolicy: mergePolicy,
  };
  const manager = {
    isCloudHost,
    getHostId: () => hostId,
    getConversation: id => conversations.get(id),
    getConversationOrThrow(id) {
      const value = conversations.get(id);
      assert.ok(value, "the controlled hydrate must install its conversation before resolving");
      return value;
    },
    onNotification(method, params, automationCapability, shouldIgnore, receivedAtMs) {
      notifications.push({ method, params, automationCapability, shouldIgnore, receivedAtMs });
    },
    onRequest: request => requests.push(request),
    updateConversationState(id, update) {
      updates.push(id);
      update(manager.getConversationOrThrow(id));
    },
    logger: { debug: (message, fields) => logs.push({ message, fields }) },
  };
  const schedule = (callback, delay) => {
    const entry = { callback, delay, cancelled: false, fired: false };
    scheduled.push(entry);
    return () => { entry.cancelled = true; };
  };
  const unexpected = () => { throw Error("unselected request conversion must not run"); };
  const globals = {
    Map, Set, Promise, Array, Object, Error,
    g: { J: value => value, D: value => value },
    // These are dependencies of the selected native merge/resolution helpers,
    // not replacement discovery or queue implementations.
    mergeCanonical(canonical, live, options) { merges.push({ canonical, live, options }); return [...canonical, ...live]; },
    i6(params) { parserCalls.push({ kind: "dynamic-tool", params }); return params; },
    tT: { ER(params, enabled, parseUrl) { parserCalls.push({ kind: "elicitation", params, enabled, parseUrl }); return params.invalid ? null : params; } },
    tw: unexpected, tO: unexpected, tR: unexpected,
  };
  const name = /^class ([A-Za-z_$][\w$]*)\{/u.exec(lifeSource)?.[1];
  assert.ok(name);
  const Lifecycle = vm.runInNewContext(
    data.readThreadId + data.bufferText + data.bufferKey + data.canonicalIslands + data.canonicalReader + data.readCanonicalHistory + data.visitTurns + data.merge + data.resolved + data.buffer + lifeSource + `;${name}`,
    globals,
  );
  const lifecycle = new Lifecycle(manager, context, schedule);
  const runtime = { parseUrl: value => value }, settings = { isOpenAIFormElicitationsEnabled: () => true };
  return {
    lifecycle, manager, context, conversations, hidden, hydrations, scheduled, notifications, requests, updates, logs, merges, parserCalls,
    notification(method, threadId = "thread-a", params = {}, extras = {}) {
      return { notification: { method, params: { threadId, ...params } }, receivedAtMs: 123, automationCapability: null, ...extras };
    },
    queue(delivery, ignore) { return lifecycle.bufferNotification(delivery, ignore); },
    request(request) { return lifecycle.bufferRequest(request, settings, runtime); },
    complete(index, conversation = {}) {
      const task = hydrations[index];
      assert.ok(task);
      conversations.set(task.id, { id: task.id, turns: [], requests: [], ...conversation });
      task.resolve(true);
    },
    runRetry(index = 0) {
      const task = scheduled[index];
      assert.ok(task && !task.cancelled && !task.fired);
      task.fired = true;
      task.callback();
    },
    flush: () => new Promise(resolve => setImmediate(resolve)),
  };
}

module.exports = { createHarness, selectLifecycle };
