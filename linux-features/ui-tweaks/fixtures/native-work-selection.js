"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");

function required(pattern, source, label) {
  const match = pattern.exec(source);
  assert.ok(match, label);
  return match;
}

function runtime(role, { mode = "work", select, autoSend = false } = {}) {
  const action = role.selection;
  const source = action.source;
  const identifiers = [...new Set(source.match(/[A-Za-z_$][\w$]*/gu))];
  const globals = Object.fromEntries(identifiers.map(name => [name, false]));
  Object.assign(globals, { Set, Promise, AbortController });
  const writes = [], focused = [], modeCalls = [], warnings = [];
  const queued = [], analytics = [];
  const account = Symbol("account"), conversation = Symbol("conversation");
  const instructions = Symbol("instructions"), pending = Symbol("pending");
  const files = Symbol("files"), lockdown = Symbol("lockdown");
  const state = new Map([
    [account, "account-a"], [conversation, "conversation-a"],
    [instructions, {}], [pending, new Set()], [files, []], [lockdown, "loaded"],
  ]);
  const scope = {
    get(key) {
      return state.has(key) ? state.get(key) : { data: {} };
    },
    set(key, value) {
      state.set(key, typeof value === "function" ? value(scope.get(key)) : value);
    },
    query: { getOrFetch: async () => ({ data: {} }) },
    when(predicate) {
      assert.equal(predicate({ get: scope.get }), true);
      return Promise.resolve();
    },
  };
  const accountRead = required(/([\w$]+)\.get\(([\w$]+)\.Pe\)!==([\w$]+)/u, source, "current account");
  const [, scopeName, accountNamespace, accountValue] = accountRead;
  globals[scopeName] = scope;
  globals[accountValue] = "account-a";
  const rootScope = required(/\.finally\(\(\)=>\{([\w$]+)\.set\([\w$]+\.wX/u, source, "root pending cleanup")[1];
  globals[rootScope] = scope;
  globals[accountNamespace] = {
    Pe: account, wX: pending, He: () => null, ac: async () => {}, k2: () => null,
  };
  const homeNamespace = required(/([\w$]+)\.homeConversationId\$/u, source, "conversation binding")[1];
  globals[homeNamespace] = { homeConversationId$: conversation };
  const instructionNamespace = required(/([\w$]+)\.nb,/u, source, "instruction binding")[1];
  globals[instructionNamespace] = { nb: instructions, sk: files, nQ: Symbol("pending-prompt") };
  const snapshotNamespace = required(/"loading"!==[\w$]+\(([\w$]+)\.chatGptConsumerLockdownAccountState\$\)/u, source, "lockdown state")[1];
  globals[snapshotNamespace] = { chatGptConsumerLockdownAccountState$: lockdown };
  const configNamespace = required(/"chat"===[\w$]+\?([\w$]+)\.c8:/u, source, "configuration query")[1];
  globals[configNamespace] = { c8: Symbol("chat-config"), av: Symbol("work-config") };
  globals[required(/\.some\(([\w$]+)\)/u, source, "native file guard")[1]] = () => false;
  globals[required(/query\.getOrFetch\(([\w$]+)\.s6\)/u, source, "configuration requirements")[1]] = { s6: Symbol("requirements") };
  const epoch = required(/([\w$]+)\.current=[\w$]+\.current\+1/u, source, "selection epoch")[1];
  globals[epoch] = { current: 0 };
  globals[required(/=\(\)=>([\w$]+)\(\)&&/u, source, "selection current check")[1]] = () => true;
  globals[required(/if\(([\w$]+)\(null\),[\w$]+\?\.type/u, source, "curated cancellation")[1]] = () => {};
  globals[required(/let [\w$]+=null==[\w$]+&&([\w$]+)\([\w$]+\)/u, source, "background selection")[1]] = () => false;
  globals[action.editor] = {
    hasText: () => false,
    view: { isDestroyed: false, state: { doc: { version: "initial" } } },
    cancelPendingSubmit() {},
    setPromptText: (text, options) => writes.push({ text, options }),
    focus: () => focused.push(true),
    requestSubmitWhenReady: predicate => queued.push(predicate),
  };
  globals[action.flushNamespace] = { flushSync: callback => callback() };
  globals[role.fields.mode] = mode;
  globals[role.fields.host] = "host-a";
  globals[role.fields.project] = "project-a";
  globals[role.fields.workRunLocation] = "cloud";
  globals[role.fields.prepareDestination] = async () => {};
  globals[role.fields.selection] = target => {
    modeCalls.push(target);
    return select?.(target);
  };
  const resetNamespace = required(/cancelPendingSubmit\(\),\(0,([\w$]+)\.aZ\)/u, source, "native pending reset")[1];
  globals[resetNamespace] = { aZ() {} };
  const errorNamespace = required(/\.catch\([\w$]+=>\{([\w$]+)\.v\.warning/u, source, "native failure logging")[1];
  globals[errorNamespace] = { v: { warning: (...args) => warnings.push(args) } };
  globals[required(/\(0,([\w$]+)\.dN\)/u, source, "selection analytics")[1]] = { dN: (...args) => analytics.push(args) };
  globals[required(/\(0,([\w$]+)\.yy\)/u, source, "native analytics events")[1]] = { yy: (...args) => analytics.push(args) };
  globals[required(/([\w$]+)\.CodexNewChatSuggestionLevel/u, source, "native analytics constants")[1]] = {
    CodexNewChatSuggestionLevel: { CODEX_NEW_CHAT_SUGGESTION_LEVEL_TASK: "task" },
    CodexOnboardingStarterPromptSelected: "selected",
    CodexAmbientSuggestionClicked: "clicked",
  };
  globals[required(/surface:([\w$]+)/u, source, "analytics surface")[1]] = "surface";
  globals[required(/\|\|([\w$]+)\([\w$]+,[\w$]+\.item,"selected"/u, source, "native selection record")[1]] = () => {};
  const actor = vm.runInNewContext(`(${action.item},${action.index},${action.options})=>{${source}}`, globals);
  return {
    writes, focused, modeCalls, warnings, queued, analytics,
    invoke(targetMode = "chat") {
      actor({
        id: "suggestion",
        prompt: "当前建议文字",
        item: {
          id: "suggestion",
          destination_metadata: { type: "prompt", entrypoint: targetMode, auto_send: autoSend },
          action_metadata: {},
          logging_metadata: {},
        },
      }, 0);
    },
    changeDocument() {
      globals[action.editor].view.state.doc = { version: "changed" };
    },
    changeAccount() {
      state.set(account, "account-b");
    },
    changeConversation() {
      state.set(conversation, "conversation-b");
    },
    changeInstructions() {
      state.set(instructions, {});
    },
    settle: () => new Promise(setImmediate),
    pending: () => scope.get(pending).size,
  };
}

module.exports = { runtime };
