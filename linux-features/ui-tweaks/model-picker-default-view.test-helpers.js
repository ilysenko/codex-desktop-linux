"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const fixture = require("./fixtures/current-model-picker-default-view.json");

function chunk(kind, moduleSource = fixture[kind].moduleSource, moduleId = fixture[kind].moduleId) {
  return `export const __rspack_esm_ids=[1];export const __webpack_modules__={${JSON.stringify(moduleId)}(${fixture[kind].params.join(",")}){${moduleSource}}};`;
}

const sources = { chat: chunk("chat"), work: chunk("work") };

function extract(source, prefix, expressionPrefix = prefix) {
  const start = source.indexOf(prefix);
  assert.ok(start >= 0 && source.indexOf(prefix, start + 1) < 0, prefix);
  const open = source.indexOf('{', start + prefix.length - 1);
  const close = createJavaScriptLexicalIndex(source).matchingBrace(open);
  assert.ok(close > open, prefix);
  const text = source.slice(start, close + 1);
  return { start, end: close + 1, source: text.replace(prefix, expressionPrefix) };
}

const chatOpenChange = extract(sources.chat, 'function nS(e,t){');
const workOpenChange = extract(sources.work, 'oH=function(e){', 'function(e){');
const workAction = extract(sources.work, 'lo=(e,l)=>{', '(e,l)=>{');
const workToggle = extract(sources.work, 'lP=e=>{', 'e=>{');
assert.equal((chatOpenChange.source.match(/t8\("simple"\)/g) ?? []).length, 1);
assert.equal((chatOpenChange.source.match(/tC&&!tK\?"simple":t6/g) ?? []).length, 1);
assert.equal((workOpenChange.source.match(/l6\("simple"\)/g) ?? []).length, 1);
assert.equal((workAction.source.match(/l6\(l\?\.showModelList\?"advanced":"simple"\)/g) ?? []).length, 1);
assert.match(sources.chat, /onToggleMenuView:t8,/);
assert.match(sources.work, /onToggleMenuView:lP,/);

function clock() {
  let next = 1;
  const tasks = new Map();
  return {
    window: {
      setTimeout(fn, delay) { assert.equal(delay, 350); const id = next++; tasks.set(id, fn); return id; },
      clearTimeout(id) { tasks.delete(id); },
    },
    flush(context) {
      for (const [id, task] of [...tasks]) {
        tasks.delete(id);
        context.timerCallback = task;
        vm.runInContext('timerCallback()', context, { timeout: 1000 });
      }
    },
  };
}

function invoke(context, expression) {
  return vm.runInContext(expression, context, { timeout: 1000 });
}

function chatScenario(initial, callbacks) {
  const timer = clock();
  const events = [];
  const context = vm.createContext({
    window: timer.window, lp: { current: null }, t6: initial, tK: false,
    tC: false, tE: false, tR: false, lP: false, t0: 'model', lA: null,
    tX: null, lU: 'model', tx: false, tM: false, ng: false, nm: null,
    lX: false, ln: { slug: 'model-a' }, to: { slug: 'model-a' }, nr: false,
    ll: null, le: null, td: null,
    d: () => () => true,
    lf: value => events.push(['focus', value]),
    lt: value => events.push(['pending', value]),
    t9: value => events.push(['initialPowerSelection', value]),
    t1: (...args) => events.push(['selection', ...args]),
    tY: value => events.push(['modelChanged', value]),
    l0: (...args) => events.push(['power', ...args]),
    tV: value => events.push(['telemetry', value]),
    tU: value => events.push(['commit', structuredClone(value)]),
    nA: () => null,
  });
  context.t8 = value => { context.t6 = value; events.push(['view', value]); };
  context.lT = value => { context.tK = value; events.push(['open', value]); };
  invoke(context, `onOpenChange = (${callbacks})`);
  const states = { initial: context.t6 };
  invoke(context, 'onOpenChange(true)');
  states.firstOpen = context.t6;
  invoke(context, 'onOpenChange(false)');
  timer.flush(context);
  states.afterCloseTimer = context.t6;
  invoke(context, 'onOpenChange(true)');
  states.reopen = context.t6;
  invoke(context, 'onOpenChange(false, { slug: "model-b", versionId: "version-b" })');
  timer.flush(context);
  states.afterModelSelection = context.t6;
  invoke(context, 'onOpenChange(true)');
  invoke(context, 't8("simple")');
  states.manualToggle = context.t6;
  invoke(context, 'onOpenChange(false)');
  timer.flush(context);
  context.tC = true;
  invoke(context, 'onOpenChange(true)');
  states.chatAlternateOpen = context.t6;
  return { states, events };
}

function workScenario(initial, openChange, action, toggleSource) {
  const timer = clock();
  const events = [];
  const context = vm.createContext({
    window: timer.window, l8: { current: null }, l7: initial, n$: false,
    Z: { PM: () => null }, lY: {}, lB: null, oy: undefined, l5: 'selection',
    oP: 'model', q: { EZ: 'selection-key' }, oZ: { current: false },
    ou: false, om: { current: { click: () => events.push(['click']) } },
    o4: selection => () => ({ then(success) { events.push(['selection', selection.model, selection.reasoningEffort]); success(true); } }),
  });
  context.l6 = value => { context.l7 = value; events.push(['view', value]); };
  context.oc = value => { context.ou = value; events.push(['open', value]); };
  invoke(context, `onOpenChange = (${openChange}); openAction = (${action}); toggle = (${toggleSource})`);
  const states = { initial: context.l7 };
  invoke(context, 'onOpenChange(true)');
  states.firstOpen = context.l7;
  invoke(context, 'onOpenChange(false)');
  timer.flush(context);
  states.afterCloseTimer = context.l7;
  invoke(context, 'openAction(undefined, undefined)');
  states.ordinaryShortcut = context.l7;
  invoke(context, 'openAction(undefined, { showModelList: true })');
  states.explicitModelListAction = context.l7;
  invoke(context, 'openAction(undefined, { showModelList: false })');
  states.explicitCompactAction = context.l7;
  invoke(context, 'openAction(undefined, undefined)');
  states.shortcutAfterExplicitCompact = context.l7;
  context.selection = { model: 'model-b', reasoningEffort: 'high', onComplete: value => events.push(['onComplete', value]) };
  invoke(context, 'openAction(undefined, { composerModelSelection: selection })');
  states.afterModelSelection = context.l7;
  invoke(context, 'toggle("simple")');
  states.manualToggle = context.l7;
  assert.equal(context.oZ.current, false);
  return { states, events };
}


function lifecycle(source, kind) {
  const expression = kind === "chat"
    ? /\[t6,t8\]=\(0,c\.useState\)\(("(?:simple|advanced)")\)/
    : /\[l7,l6\]=\(0,g\.useState\)\(("(?:simple|advanced)")\)/;
  const initial = source.match(expression);
  assert.ok(initial, "native view state declaration");
  return kind === "chat"
    ? chatScenario(JSON.parse(initial[1]), extract(source, "function nS(e,t){").source)
    : workScenario(JSON.parse(initial[1]),
      extract(source, "oH=function(e){", "function(e){").source,
      extract(source, "lo=(e,l)=>{", "(e,l)=>{").source,
      extract(source, "lP=e=>{", "e=>{").source);
}

module.exports = { fixture, chunk, lifecycle };
