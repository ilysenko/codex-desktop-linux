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

// Keep current complete fixtures intact. Inert behavior tests use the
// coherently mapped native fragments with stable bindings in this harness.
function stableFragment(source, aliases) {
  const inverse = Object.fromEntries(Object.entries(aliases).map(([stable, current]) => [current, stable]));
  const lexical = createJavaScriptLexicalIndex(source);
  return source.replace(/[A-Za-z_$][\w$]*/gu, (name, index) => {
    let previous = index - 1;
    while (previous >= 0 && (!lexical.isCode(previous) || /\s/u.test(source[previous]))) previous--;
    const property = ["{", ","].includes(source[previous]) && /^\s*:/u.test(source.slice(index + name.length));
    const member = source[index - 1] === "." && source.slice(index - 3, index) !== "...";
    return lexical.isCode(index) && Object.hasOwn(inverse, name) && !property && !member ? inverse[name] : name;
  });
}

function moduleContext(owner, imports) {
  const load = id => { assert.ok(Object.hasOwn(imports, id), `unexpected native dependency ${id}`); return imports[id]; };
  load.d = (target, getters, values) => {
    for (const [key, get] of Object.entries(getters ?? {})) Object.defineProperty(target, key, { get });
    Object.assign(target, values);
  };
  const context = vm.createContext({ load, exports: {} });
  vm.runInContext(`(function(${owner.params.join(",")}){${owner.moduleSource}})({},exports,load);`, context, { timeout: 1000 });
  return context;
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
    oyxz: { A: "NativeFormattedMessage" }, erx1: { Y: "NativePickerDropdown" },
    TWUU: { ig: () => undefined, CT: choices },
    moNn: { h: new Proxy({}, { get: (_target, effort) => ({ id: effort }) }) },
    hI9J: moduleContext(fixture.effortSelectionHelper, {
      FQih: { UL: ["low", "medium", "high", "xhigh", "ultra"], eE: effort => ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort) },
      ER5p: { SP: (_effort, efforts) => efforts[0] },
    }).exports,
    bqtn: { ms: { Separator: "NativeSeparator" }, yl: "NativeSubmenu" },
    Q3tq: { pN: "enabled-efforts" }, OWtl: { u: "store" }, OMIV: { JW: "model-query" },
    m5SM: { O: "NativePermissionControls" }, sByQ: { e: "NativeAdvancedView" },
    pap3: { a: "NativeModelDescription" }, TI8r: { R: () => true }, eR8N: { P: "NativeModelLabel" },
    bVeK: { UBC: "NativeIndicator" }, b6HF: { K: "NativeSelectedLabel" },
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
  const context = moduleContext(fixture[kind], imports);
  context.props = props;
  vm.runInContext("output=exports.i(props)", context, { timeout: 1000 });
  const nativeRoot = context.output;
  const output = nativeRoot.type === "NativeSubmenu" ? nativeRoot.props.children : nativeRoot;
  assert.ok(["NativePickerDropdown", "NativeAdvancedView"].includes(output.type));
  return { output, nativeRoot, modelListConfig: output.props.modelListConfig, events, props };
}


function renderChatOptions({ allowSelection = true, extraModels = [], fallbackOptions = [] } = {}) {
  const events = [];
  const source = require("./fixtures/current-model-picker-default-view.json").chat.moduleSource;
  const lexical = createJavaScriptLexicalIndex(source);
  const aliases = fixture.testAliases.chatOptions;
  const selectionName = aliases.nU;
  const selectionStart = source.indexOf(selectionName + "=function(e){");
  assert.ok(selectionStart >= 0);
  const selectionOpen = source.indexOf("{", selectionStart);
  const selectionEnd = lexical.matchingBrace(selectionOpen);
  const selection = stableFragment(source.slice(selectionStart + selectionName.length + 1, selectionEnd + 1), aliases);
  const start = source.indexOf("let " + aliases.nH + "={");
  assert.ok(start >= 0);
  const objectEnd = lexical.matchingBrace(source.indexOf("{", start));
  const after = source.indexOf("if(!" + aliases.t0 + "){", objectEnd);
  assert.equal(after, objectEnd + 2);
  const end = lexical.matchingBrace(source.indexOf("{", after));
  const construction = stableFragment(source.slice(start, end + 1), aliases);
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
    n: jsxRuntime, m: { A: "NativeFormattedMessage" }, I: { a: "NativeDescription" }, nj: new Set(),
    eG: "NativeRateLimitDescription", eI: undefined, t0: false, tD: false, tw: false,
    l9: undefined, ni: versions[0], ne: false, nn: entries[0], l5: { versionOptions: entries },
    tX: { versionOptions: versions, options: [] }, t5: true, nl: false, lX: undefined,
    q: { y3: "special-model" }, nE: undefined, np: undefined, tV: undefined, lC: false,
    nS: null, nC: [], l3: false, nt: "model", lO: { slug: "model-a", thinkingEffort: "medium" }, nK: undefined, no: fallbackOptions, t2: extraModels, tp: false,
    tJ: () => true,
    et: { VK: (choice, selected) => choice.slug === selected.slug },
    lz: new Map([["limited", { resets_after: 200, description: "Usage limit reached" }]]),
    lo: { formatDate: value => value }, eW: version => version.slugs, eq: option => option.slug, lZ: new Set(),
    tl: (_catalog, version) => choices.get(version.id),
    nw: () => undefined, nM: false,
    t6: slug => { events.push(["before", slug]); return allowSelection; },
    lT: (...values) => events.push(["selectionMode", ...values]),
    ls: slug => events.push(["modelChanged", slug]),
    nh: value => events.push(["select", structuredClone(value)]),
    la: value => events.push(["telemetry", value]),
  });
  vm.runInContext(`const nU=(${selection});${construction};modelListConfig=nH`, context, { timeout: 1000 });
  return { modelListConfig: context.modelListConfig, events };
}

function renderInlineMenu(props, source = fixture.inlineRenderer.moduleSource) {
  props = { compactAutoModel: "auto", selectedModel: "model-a", ...props };
  const refs = [];
  const layoutEffects = [];
  const effects = [];
  let id = 0;
  const context = vm.createContext({
    props, o: jsxRuntime, i: memo, l: { G: "NativeSelectedIcon" }, r: { Pg: () => null },
    a: {
      useId: () => `native-model-description-${++id}`,
      useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
      useState: value => [value, () => {}],
      useLayoutEffect: callback => layoutEffects.push(callback),
      useEffect: callback => effects.push(callback),
    },
    s: { A: "NativeFormattedMessage" }, d: { F: "Space" }, c: { nr3: "NativeLockIcon" },
    u: { ms: { Item: "NativeMenuItem" } },
    er: { A: new Proxy({}, { get: (_target, key) => `Native${key}` }) },
    eL: "NativeViewControls", ea: "NativeSimpleSlider", h: "NativeOlderSubmenu",
    document: { body: {}, activeElement: null }, HTMLElement: class HTMLElement {},
  });
  const aliases = fixture.testAliases.inlineRows;
  const functions = ["eT", "eD", "eP", "eA"].map(name =>
    stableFragment(nativeFunction(source, aliases[name] ?? name), aliases)).join("\n");
  vm.runInContext(`${functions}\noutput=eA(props)`, context, { timeout: 1000 });
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
  if (!state.stopped) menu.output.props.onKeyDown?.(event);
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
