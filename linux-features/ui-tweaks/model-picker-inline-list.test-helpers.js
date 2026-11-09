"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const fixture = require("./fixtures/current-native-inline-model-list.json");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");

function jsx(type, props, key) { return { type, props, key }; }
const jsxRuntime = { jsx, jsxs: jsx, Fragment: "NativeFragment" };
const memo = { c: size => Array(size).fill(Symbol.for("react.memo_cache_sentinel")) };

function chunk(kind, moduleSource = fixture[kind].moduleSource, moduleId = fixture[kind].moduleId) {
  return `export const __rspack_esm_ids=[1];export const __webpack_modules__={${JSON.stringify(moduleId)}(${fixture[kind].params.join(",")}){${moduleSource}}};`;
}

function carrier(kinds, overrides = {}) {
  return `export const __rspack_esm_ids=[1];export const __webpack_modules__={${kinds.map(kind => {
    const item = { ...fixture[kind], ...overrides[kind] };
    return `${JSON.stringify(item.moduleId)}(${item.params.join(",")}){${item.moduleSource}}`;
  }).join(",")}};`;
}

function nativeFunction(source, name) {
  const prefix = `function ${name}(`;
  const start = source.indexOf(prefix);
  assert.ok(start >= 0 && source.indexOf(prefix, start + 1) < 0, name);
  const open = source.indexOf("{", start);
  const end = createJavaScriptLexicalIndex(source).matchingBrace(open);
  assert.ok(end > open, name);
  return source.slice(start, end + 1);
}

function renderModelProvider(kind, overrides = {}, enabledEfforts = ["low", "medium", "high"]) {
  const events = [];
  const models = [
    { model: "model-a", displayName: "Model A", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
    { model: "model-b", displayName: "Model B", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], description: "Model B description" },
    { model: "locked", displayName: "Locked model", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  ];
  const choices = (catalog, selected) => (catalog ?? []).filter(model => model.model === selected)
    .flatMap(model => model.supportedReasoningEfforts.map(effort => ({ model: model.model, reasoningEffort: effort.reasoningEffort })));
  const imports = {
    ABep: jsxRuntime, QosV: memo, on57: { A: (...values) => values.filter(Boolean).join(" ") },
    zTeN: { gh: () => ({ get: () => new Set(enabledEfforts) }), Ul: () => null, _U: () => false },
    WPra: { _: { options: ["low", "medium", "high", "xhigh", "ultra"] } },
    Wf1j: { A: () => ({ formatMessage: value => value.defaultMessage }) },
    oyxz: { A: "NativeFormattedMessage" }, ivi7: { Y: "NativePickerDropdown" },
    TWUU: { ig: () => undefined, CT: choices }, moNn: {},
    hI9J: { uR: choices, MD: effort => effort },
    bqtn: { ms: { Separator: "NativeSeparator" }, yl: "NativeSubmenu" },
    Q3tq: { pN: "enabled-efforts" }, OWtl: { u: "store" }, OMIV: { JW: "model-query" },
    m5SM: { O: "NativePermissionControls" }, vdOM: { e: "NativeAdvancedView" },
    pap3: { a: "NativeModelDescription" }, TI8r: { R: () => true }, eR8N: { P: "NativeModelLabel" },
  };
  const props = {
    model: "model-a", models, modelOptions: models.map(model => ({ model, disabledReason: null })),
    modelOptionsDisabled: false, modelPickerTriggerConfig: {}, menuView: "advanced", open: true,
    powerSelections: [], serviceTierOptions: [], reasoningEffort: "medium", selectionMode: "model",
    lockedModelSlug: "locked",
    onBeforeSelectModel: model => { events.push(["before", model]); return true; },
    onSelectModel: (model, effort) => events.push(["select", model, effort]),
    onSelectModelOption: () => events.push(["complete"]),
    onSelectDefault: () => events.push(["default"]),
    onOpenChange: value => events.push(["open", value]),
    onToggleMenuView: value => events.push(["view", value]),
    ...overrides,
  };
  const load = id => { assert.ok(Object.hasOwn(imports, id), `unexpected native dependency ${id}`); return imports[id]; };
  load.d = (target, getters, values) => {
    for (const [key, get] of Object.entries(getters ?? {})) Object.defineProperty(target, key, { get });
    Object.assign(target, values);
  };
  const context = vm.createContext({ load, exports: {}, props });
  const owner = fixture[kind];
  vm.runInContext(`(function(${owner.params.join(",")}){${owner.moduleSource}})({},exports,load); output=exports.i(props)`, context, { timeout: 1000 });
  assert.equal(context.output.type, "NativePickerDropdown");
  return { output: context.output, modelListConfig: context.output.props.modelListConfig, events, props };
}


function renderChatOptions({ allowSelection = true } = {}) {
  const events = [];
  const source = require("./fixtures/current-model-picker-default-view.json").chat.moduleSource;
  const lexical = createJavaScriptLexicalIndex(source);
  const selectionStart = source.indexOf("nd=function(e){");
  const selectionOpen = source.indexOf("{", selectionStart);
  const selectionEnd = lexical.matchingBrace(selectionOpen);
  const selection = source.slice(selectionStart + 3, selectionEnd + 1);
  const start = source.indexOf("let n_={");
  const objectEnd = lexical.matchingBrace(source.indexOf("{", start));
  const after = source.indexOf("if(!tR){", objectEnd);
  assert.equal(after, objectEnd + 2);
  const end = lexical.matchingBrace(source.indexOf("{", after));
  const construction = source.slice(start, end + 1);
  const versions = [
    { id: "version-a", label: "Model A", defaultModelSlug: "model-a", slugs: ["model-a"] },
    { id: "version-b", label: "Third-party Model B", defaultModelSlug: "model-b", slugs: ["model-b"], description: "Model B description" },
    { id: "version-limited", label: "Limited model", defaultModelSlug: "limited", slugs: ["limited"] },
  ];
  const choices = new Map([
    ["version-a", { slug: "model-a", thinkingEffort: "medium", versionId: "version-a" }],
    ["version-b", { slug: "model-b", thinkingEffort: "high", versionId: "version-b" }],
  ]);
  const entries = versions.map(version => ({ version }));
  const context = vm.createContext({
    n: jsxRuntime, p: { A: "NativeFormattedMessage" }, C: { a: "NativeDescription" },
    eM: "NativeRateLimitDescription", e_: undefined, tR: false, tE: false, tC: false,
    lN: undefined, lH: versions[0], lw: false, lK: entries[0], lO: { versionOptions: entries },
    tO: { versionOptions: versions, options: [] }, tN: true, lG: false, ly: undefined,
    B: { y3: "special-model" }, lZ: undefined, l$: undefined, tS: undefined, t2: false,
    l8: null, l2: [], lL: false, lU: "model", nc: undefined, lj: [], lI: [], tp: false,
    lv: new Map([["limited", { resets_after: 200, description: "Usage limit reached" }]]),
    tj: { formatDate: value => value }, eW: version => version.slugs, eq: option => option.slug, lC: new Set(),
    e3: (_catalog, version) => choices.get(version.id),
    ns: () => undefined, nr: false,
    tw: slug => { events.push(["before", slug]); return allowSelection; },
    t1: (...values) => events.push(["selectionMode", ...values]),
    tY: slug => events.push(["modelChanged", slug]),
    l0: value => events.push(["select", structuredClone(value)]),
    tV: value => events.push(["telemetry", value]),
  });
  vm.runInContext(`const nd=(${selection});${construction};modelListConfig=n_`, context, { timeout: 1000 });
  return { modelListConfig: context.modelListConfig, events };
}

function renderInlineMenu(props, source = fixture.inlineRenderer.moduleSource) {
  const refs = [];
  const layoutEffects = [];
  const effects = [];
  let id = 0;
  const context = vm.createContext({
    props, r: jsxRuntime, o: memo, i: { G: "NativeSelectedIcon" }, l: { Pg: () => null },
    a: {
      useId: () => `native-model-description-${++id}`,
      useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
      useState: value => [value, () => {}],
      useLayoutEffect: callback => layoutEffects.push(callback),
      useEffect: callback => effects.push(callback),
    },
    s: { A: "NativeFormattedMessage" }, d: { F: "Space" }, c: { nr3: "NativeLockIcon" },
    u: { ms: { Item: "NativeMenuItem" } },
    et: { A: new Proxy({}, { get: (_target, key) => `Native${key}` }) },
    eL: "NativeViewControls", en: "NativeSimpleSlider", e6: "NativeModelHeading",
    document: { body: {}, activeElement: null }, HTMLElement: class HTMLElement {},
  });
  vm.runInContext(`${nativeFunction(source, "eT")}\n${nativeFunction(source, "eA")}\n${nativeFunction(source, "eP")}\n${nativeFunction(source, "eS")}\noutput=eS(props)`, context, { timeout: 1000 });
  return { output: context.output, context, refs, layoutEffects, effects };
}

function findNodes(tree, predicate) {
  if (tree == null || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(item => findNodes(item, predicate));
  return [...(predicate(tree) ? [tree] : []), ...findNodes(tree.props?.children, predicate)];
}

function keyboardEvent(menu, nodes, target, key, shiftKey = false) {
  const state = { prevented: false, stopped: false };
  const event = {
    target, key, code: key, shiftKey,
    currentTarget: { querySelectorAll(selector) {
      assert.equal(selector, '[role^="menuitem"]:not([data-disabled]):not([data-interactive="false"])');
      return nodes.filter(node => !node.disabled && node.interactive !== false);
    } },
    preventDefault: () => { state.prevented = true; },
    stopPropagation: () => { state.stopped = true; },
  };
  menu.output.props.onKeyDownCapture(event);
  return state;
}

function keyboardNode(menu, id, options = {}) {
  const node = new menu.context.HTMLElement();
  Object.assign(node, {
    id, focusCalls: [], disabled: false, hidden: false,
    getAttribute: () => null,
    closest(selector) {
      if (selector === '[inert], [hidden], [aria-hidden="true"]') return this.hidden ? this : null;
      if (selector === '[role="slider"]') return this.slider ? this : null;
      return null;
    },
    contains: other => other === node,
    matches: () => true,
    focus(value) { this.focusCalls.push(value); },
    ownerDocument: { getElementById: () => null },
  }, options);
  return node;
}

module.exports = { fixture, chunk, carrier, nativeFunction, renderModelProvider, renderChatOptions, renderInlineMenu, findNodes, keyboardEvent, keyboardNode };
