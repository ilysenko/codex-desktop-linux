"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
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

// The fixtures retain complete signed factories. Execute only the native
// lifecycle fragments, coherently renamed to this harness's stable bindings.
function renamedBindings(source, bindings) {
  const lexical = createJavaScriptLexicalIndex(source);
  return source.replace(/[A-Za-z_$][\w$]*/gu, (name, index) =>
    lexical.isCode(index) && Object.hasOwn(bindings, name) && source[index - 1] !== "." &&
      !/^\s*:/u.test(source.slice(index + name.length)) ? bindings[name] : name);
}

function nativePrefix(prefix, kind) {
  return prefix.replace(/[A-Za-z_$][\w$]*/gu, name => fixture.lifecycleAliases[kind][name] ?? name);
}

function extractLifecycle(source, kind, prefix, expressionPrefix = prefix) {
  const part = extract(source, nativePrefix(prefix, kind));
  const inverse = Object.fromEntries(Object.entries(fixture.lifecycleAliases[kind]).map(([stable, current]) => [current, stable]));
  const normalized = renamedBindings(part.source, inverse);
  assert.ok(normalized.startsWith(prefix));
  return { ...part, source: normalized.replace(prefix, expressionPrefix) };
}

const chatOpenChange = extractLifecycle(sources.chat, 'chat', 'function n3(e,t){');
const workOpenChange = extractLifecycle(sources.work, 'work', 'ot=function(e){', 'function(e){');
const workAction = extractLifecycle(sources.work, 'work', 'lr=(e,l)=>{', '(e,l)=>{');
const workToggle = extractLifecycle(sources.work, 'work', 'lD=e=>{', 'e=>{');
assert.equal((chatOpenChange.source.match(/lS\("simple"\)/g) ?? []).length, 1);
assert.equal((chatOpenChange.source.match(/tw&&!le\?"simple":lb/g) ?? []).length, 1);
assert.equal((workOpenChange.source.match(/ns\("simple"\)/g) ?? []).length, 1);
assert.equal((workAction.source.match(/ns\(l\?\.showModelList\?"advanced":"simple"\)/g) ?? []).length, 1);
assert.match(sources.chat, new RegExp("onToggleMenuView:" + escapeRegExp(fixture.lifecycleAliases.chat.lS) + ","));
assert.match(sources.work, new RegExp("onToggleMenuView:" + escapeRegExp(fixture.lifecycleAliases.work.lD) + ","));

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

function chatScenario(initial, callbacks, closeSelection) {
  const timer = clock();
  const events = [];
  const context = vm.createContext({
    window: timer.window, lF: { current: null }, lb: initial, le: false,
    tw: false, tD: false, t0: false, l$: false, lh: 'model', lJ: null,
    lg: null, nt: 'model', t3: false, t4: false, nW: false, nY: null,
    ng: false, lO: { slug: 'model-a' }, tP: { slug: 'model-a' }, nM: false,
    lL: null, lk: null, tS: null,
    c: () => () => true,
    lY: value => events.push(['focus', value]),
    lD: value => events.push(['pending', value]),
    ly: value => events.push(['initialPowerSelection', value]),
    lT: (...args) => events.push(['selection', ...args]),
    ls: value => events.push(['modelChanged', value]),
    nh: (...args) => events.push(['power', ...args]),
    la: value => events.push(['telemetry', value]),
    t8: value => events.push(['commit', structuredClone(value)]),
    n0: () => null,
  });
  context.lS = value => { context.lb = value; events.push(['view', value]); };
  context.lq = value => { context.le = value; events.push(['open', value]); };
  invoke(context, `n2 = (${closeSelection}); onOpenChange = (${callbacks})`);
  const states = { initial: context.lb };
  invoke(context, 'onOpenChange(true)');
  states.firstOpen = context.lb;
  invoke(context, 'onOpenChange(false)');
  timer.flush(context);
  states.afterCloseTimer = context.lb;
  invoke(context, 'onOpenChange(true)');
  states.reopen = context.lb;
  invoke(context, 'onOpenChange(false, { slug: "model-b", versionId: "version-b" })');
  timer.flush(context);
  states.afterModelSelection = context.lb;
  invoke(context, 'onOpenChange(true)');
  invoke(context, 'lS("simple")');
  states.manualToggle = context.lb;
  invoke(context, 'onOpenChange(false)');
  timer.flush(context);
  context.tw = true;
  invoke(context, 'onOpenChange(true)');
  states.chatAlternateOpen = context.lb;
  return { states, events };
}

function workScenario(initial, openChange, action, toggleSource) {
  const timer = clock();
  const events = [];
  const context = vm.createContext({
    window: timer.window, na: { current: null }, ni: initial, n5: false,
    Y: { PM: () => null }, l6: {}, l0: null, t_: undefined, no: 'selection',
    tV: 'model', K: { EZ: 'selection-key' }, ol: { current: false },
    tC: false, tk: { current: { click: () => events.push(['click']) } },
    ou: selection => () => ({ then(success) { events.push(['selection', selection.model, selection.reasoningEffort]); success(true); } }),
  });
  context.ns = value => { context.ni = value; events.push(['view', value]); };
  context.tI = value => { context.tC = value; events.push(['open', value]); };
  invoke(context, `onOpenChange = (${openChange}); openAction = (${action}); toggle = (${toggleSource})`);
  const states = { initial: context.ni };
  invoke(context, 'onOpenChange(true)');
  states.firstOpen = context.ni;
  invoke(context, 'onOpenChange(false)');
  timer.flush(context);
  states.afterCloseTimer = context.ni;
  invoke(context, 'openAction(undefined, undefined)');
  states.ordinaryShortcut = context.ni;
  invoke(context, 'openAction(undefined, { showModelList: true })');
  states.explicitModelListAction = context.ni;
  invoke(context, 'openAction(undefined, { showModelList: false })');
  states.explicitCompactAction = context.ni;
  invoke(context, 'openAction(undefined, undefined)');
  states.shortcutAfterExplicitCompact = context.ni;
  context.selection = { model: 'model-b', reasoningEffort: 'high', onComplete: value => events.push(['onComplete', value]) };
  invoke(context, 'openAction(undefined, { composerModelSelection: selection })');
  states.afterModelSelection = context.ni;
  invoke(context, 'toggle("simple")');
  states.manualToggle = context.ni;
  assert.equal(context.ol.current, false);
  return { states, events };
}


function lifecycle(source, kind) {
  const prefix = nativePrefix(kind === "chat" ? "[lb,lS]=(0,E.useState)(" : "[ni,ns]=(0,g.useState)(", kind);
  const at = source.indexOf(prefix);
  assert.ok(at >= 0 && source.indexOf(prefix, at + prefix.length) < 0, "native view state declaration");
  const initial = /^("(?:simple|advanced)")\)/u.exec(source.slice(at + prefix.length));
  assert.ok(initial, "native view state value");
  return kind === "chat"
    ? chatScenario(JSON.parse(initial[1]), extractLifecycle(source, "chat", "function n3(e,t){").source,
      extractLifecycle(source, "chat", "n2=function(e){", "function(e){").source)
    : workScenario(JSON.parse(initial[1]),
      extractLifecycle(source, "work", "ot=function(e){", "function(e){").source,
      extractLifecycle(source, "work", "lr=(e,l)=>{", "(e,l)=>{").source,
      extractLifecycle(source, "work", "lD=e=>{", "e=>{").source);
}

module.exports = { fixture, chunk, lifecycle };
