"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { HOME_CONTENT_SOURCE_MARKER: marker, applySuggestedPromptsHomeContentPatch: apply,
  suggestedPromptsHomeContentContract: state } = require("./patches/suggested-prompts-content.js");
const { descriptors } = require("./patches/suggested-prompts.js");
const { applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { findUniqueRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const fixture = require("./fixtures/suggested-prompts-content.js");
const selected = descriptors.filter(d => d.id === "home-suggested-prompts-content");
const context = { feature: { settings: { tweaks: { home: { suggestedPrompts: { enabled: true } } } } } };

function workspace(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "suggested-prompts-content-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return { root, read: name => fs.readFileSync(path.join(root, "webview/assets", name), "utf8"), run() {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, normalizePatchDescriptors(selected), context, report, selected[0].phase);
    return report.patches[0];
  } };
}

function compactRender(source, options) {
  const modules = vm.runInNewContext(
    source.replace("export const __webpack_modules__=", "globalThis.__webpack_modules__="));
  const exports = {};
  const imports = {
    runtime: { iK: () => options.runtime }, settings: { pref: { enabled: "enabled" } },
    store: { Ul: () => options.debug ?? null }, jsx: { jsx: (Component, props) => Component(props) },
    policy: {
      fy: () => ({ data: false, isLoading: false }),
      o1: ({ debugOverride, experimentEligible, personalized }) => debugOverride ?? (experimentEligible && personalized ? "generated" : "curated"),
      b4: ({ canUsePersonalizedSuggestions, generatedSuggestionsEnabled, hasGeneratedSuggestionsReadSettled, shouldUseCuratedNewChatPageSuggestions }) =>
        shouldUseCuratedNewChatPageSuggestions || !generatedSuggestionsEnabled || !canUsePersonalizedSuggestions || hasGeneratedSuggestionsReadSettled,
    },
  };
  const load = id => imports[id];
  load.d = (target, getters) => Object.entries(getters).forEach(([key, get]) => Object.defineProperty(target, key, { get }));
  modules.Content({}, exports, load);
  return exports.HomeAmbientSuggestionsContent({ page: options.page, root: options.project, host: "local" });
}

test("content keeps native curated fallback whenever runtime/page/project or explicit source override disables generated", () => {
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(state(patched), "patched");
  assert.equal(apply(patched), patched);
  for (const runtime of [false, true]) for (const page of [false, true]) for (const project of [null, "/project"]) {
    const options = { runtime, page, project };
    const before = compactRender(fixture, options), after = compactRender(patched, options);
    if (!(runtime && page && project != null)) assert.equal(JSON.stringify(after), JSON.stringify(before));
    else assert.equal(after.curated, false);
  }
  for (const debug of ["curated", "generated"]) {
    const options = { runtime: true, page: true, project: "/project", debug };
    assert.equal(JSON.stringify(compactRender(patched, options)), JSON.stringify(compactRender(fixture, options)));
  }
});

test("content rejects wrong policy/context/record/owner and incomplete applied-state bindings", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture);
  const duplicateInputs = new Set([fixture + fixture, fixture + patched, patched + patched]);
  for (const source of [
    fixture.replace('Me=i&&null!=l', 'Me=wrongPage&&null!=l'),
    fixture.replace('Ne=null==De&&Me&&Ee', 'Ne=null==De&&Me&&wrongRuntime'),
    fixture.replace('enabled:Ne,hostId:host', 'enabled:Ne,hostId:wrongHost'),
    fixture.replace('debugOverride:De', 'debugOverride:wrongDebug'),
    fixture.replace('generatedSuggestionsEnabled:Me,hasGenerated', 'generatedSuggestionsEnabled:wrongGenerated,hasGenerated'),
    fixture.replace('shouldUseCuratedNewChatPageSuggestions:z', 'shouldUseCuratedNewChatPageSuggestions:wrongFlag'),
    fixture.replace('b4)({canUse', 'wrongPolicy.b4)({canUse'),
    patched.replace('"curated"===ze&&!Ne', '"curated"===ze&&!wrongQuery'),
    patched.replace('"curated"===ze&&!Ne', '"curated"===wrongSource&&!Ne'),
    patched.replace(`&&!Ne/*${marker}*/`, `&&Ne/*${marker}*/`),
    patched.replace(`/*${marker}*/`, ""),
    patched.replace('function ua(e){', 'function wrongOwner(e){'),
    patched.replace('HomeAmbientSuggestionsContent:()=>Home', 'HomeAmbientSuggestionsContent:()=>wrongWrapper'),
    patched.replace('tf=r("policy")', 'tf=wrongLoader("policy")'),
    fixture.replace('Me=i&&null!=l,Ne=null==De&&Me&&Ee', 'unused=()=>{let Me=i&&null!=l,Ne=null==De&&Me&&Ee},Me=false,Ne=false'),
    fixture.replace('let options=', 'Ne=false;let options='),
    fixture.replace('else ze=eB[1]', 'else wrongSource=eB[1]'),
    fixture.replace('let z="curated"===ze;', `let z=("curated"===ze,function ${marker}(){return!1}());`),
    patched + `function ${marker}(){return false}`,
    fixture + fixture, fixture + patched, patched + patched,
  ]) {
    assert.notEqual(source, patched);
    if (!duplicateInputs.has(source)) assert.equal(javascriptSourceParses(source), true);
    assert.equal(state(source), "drifted");
    assert.equal(apply(source), source);
  }
});

function exportVariants(registration, requireName, exportsName) {
  return {
    wrong_receiver: `const __codexOtherExports={};${registration.replace(`(${exportsName},`, '(__codexOtherExports,')};`,
    loader_suffix: `shadow${registration};`,
    string: `const __codexUnusedExport=${JSON.stringify(registration)};`,
    function: `function __codexUnusedExport(){${registration}};`,
    arrow: `const __codexUnusedExport=()=>${registration};`,
    conditional: `if(false)${registration};`,
    for_body: `for(;false;)${registration};`,
    for_header: `for(;${registration};){}`,
    expression: `void ${registration};`,
    property_receiver: `holder.${requireName}.d${registration.slice(registration.indexOf("("))};`,
  };
}

test("content accepts only the factory's authoritative export statement, never nested or expression lookalikes", t => {
  t.mock.method(console, "warn", () => {});
  const registration = 'r.d(t,{HomeAmbientSuggestionsContent:()=>Home})';
  const variants = exportVariants(registration, "r", "t");
  for (const input of [fixture, apply(fixture)]) for (const [name, replacement] of Object.entries(variants)) {
    const source = input.replace(registration, replacement);
    assert.notEqual(source, input, name);
    assert.equal(javascriptSourceParses(source), true, name);
    assert.equal(state(source), "drifted", name);
    assert.equal(apply(source), source, name);
    const app = workspace(t, { "async/export-authority.js": source });
    assert.equal(app.run().status, "skipped-optional", name);
    assert.equal(app.read("async/export-authority.js"), source, name);
  }
});

test("content normal descriptor validates every same-ID copy before a verified transaction", t => {
  const renamed = fixture.replace(/(?<![\w$])Ne(?![\w$])/g, "$query").replace(/(?<![\w$])Me(?![\w$])/g, "$generated");
  const app = workspace(t, { "async/one.js": fixture, "nested/two.js": renamed });
  assert.equal(app.run().status, "applied");
  assert.equal(app.read("async/one.js"), apply(fixture));
  assert.equal(app.read("nested/two.js"), apply(renamed));
  assert.equal(app.run().status, "already-applied");
});

test("content missing/marker-free/damaged/mixed or different module copies leave every asset unchanged", t => {
  t.mock.method(console, "warn", () => {});
  for (const second of [
    'export const __webpack_modules__={Content(e,t,r){const missing=true;}};',
    fixture.replace('let z="curated"===ze;', 'let z=false;'),
    apply(fixture),
    fixture.replace('Content(e,t,r)', 'OtherContent(e,t,r)'),
    apply(fixture).replace('"curated"===ze&&!Ne', '"curated"===ze&&!wrongQuery'),
  ]) {
    const app = workspace(t, { "async/one.js": fixture, "nested/two.js": second });
    assert.equal(app.run().status, "skipped-optional");
    assert.equal(app.read("async/one.js"), fixture);
    assert.equal(app.read("nested/two.js"), second);
  }
});

function contentOwner(module) {
  const index = module.moduleSource.indexOf('shouldUseCuratedNewChatPageSuggestions:');
  const owners = [...module.moduleSource.matchAll(/function ([\w$]+)\(([\w$]+)\)\{/g)].map(header => ({
    name: header[1], start: header.index, end: findMatchingBrace(module.moduleSource, header.index + header[0].length - 1),
  })).filter(owner => owner.start < index && index < owner.end);
  assert.equal(owners.length, 1);
  return { ...owners[0], source: module.moduleSource.slice(owners[0].start, owners[0].end + 1) };
}

function nativeHarness(module, policyModule, initial = {}) {
  // Execute the actual factory, selectors, memoized component and native card
  // actions. Query/hooks/renderer/transport are inert boundaries; this does not
  // initialize the outer Home bootstrap or mount a React DOM tree.
  const owner = contentOwner(module), source = owner.source;
  const reads = [...source.matchAll(/\blet ([\w$]+)=\(0,([\w$]+)\._U\)\(([\w$]+),([\w$]+)\)/g)];
  assert.ok(reads.length >= 5);
  const storeAlias = reads[0][2];
  const ctx = /([\w$]+)=([\w$]+)&&null!=([\w$]+),([\w$]+)=null==([\w$]+)&&\1&&([\w$]+)/.exec(source);
  assert.ok(ctx);
  const debugToken = new RegExp(`${escapeRegExp(ctx[5])}=\\(0,${escapeRegExp(storeAlias)}\\.Ul\\)\\(([\\w$]+)\\)`).exec(source)[1];
  const settledIndex = module.moduleSource.indexOf(`${reads[2][3]}=(0,${storeAlias}.i1)`);
  const base = /let [\w$]+=[\w$]+\(([\w$]+),[\w$]+\)/.exec(module.moduleSource.slice(settledIndex, settledIndex + 250))[1];
  const scopes = [...source.matchAll(/([\w$]+)=\(0,[\w$]+\.gh\)\(([\w$]+\.[\w$]+)\)/g)];
  assert.equal(scopes.length, 3);
  const binding = alias => { const found = findRspackRequireBinding(module, alias); assert.ok(found, alias); return found.moduleId; };
  const runtimeAlias = new RegExp(`${escapeRegExp(ctx[6])}=!0===\\(0,([\\w$]+)\\.([\\w$]+)\\)`).exec(source);
  const policyAlias = /\(0,([\w$]+)\.[\w$]+\)\(\{canUsePersonalizedSuggestions:/.exec(source)[1];
  const memoAlias = /\(0,([\w$]+)\.c\)\(119\)/.exec(source)[1];
  const reactAlias = /\(0,([\w$]+)\.useRef\)/.exec(source)[1];
  const jsxAlias = /\(0,([\w$]+)\.jsx\)/.exec(source)[1];
  const authAlias = /[\w$]+=\(0,([\w$]+)\.As\)\(\)/.exec(source)[1];
  const intlAlias = /[\w$]+=\(0,([\w$]+)\.A\)\(\)/.exec(source)[1];
  const featureAlias = /\(0,([\w$]+)\.Ou\)\("452956359"\)/.exec(source)[1];
  const composerCall = /case"fill-composer":[^;]*?\(0,([\w$]+)\.([\w$]+)\)\([\w$]+,[\w$]+\)/.exec(source);
  const focusCall = /\(0,([\w$]+)\.([\w$]+)\)\(\{text:[\w$]+\}\)/.exec(source);
  assert.ok(composerCall && focusCall);
  const state = { runtime: true, debug: null, hasEnabledApps: false, accessLoading: false,
    featureDiscovery: true, plugins: [], apps: [], composerText: "", query: { data: { file: { currentSuggestionIds: [], suggestions: [] } }, isError: false }, ...initial };
  const calls = { composer: [], focus: [], reads: [], mutations: [], connectedQueries: [], install: [], telemetry: [] };
  const memo = [], refs = [], effects = [], domains = new Map(), values = new Map();
  let memoIndex = 0, refIndex = 0, effectIndex = 0, tokenIndex = 0, bindings;
  const effectDeps = [];
  const atom = (kind, args) => ({ kind, args, fn: args.findLast(value => typeof value === "function"), id: ++tokenIndex });
  const ready = { available: false, allowed: false, isLoading: false, isPending: false, data: [], isSuccess: true, refetch: async () => {}, get: () => false };
  function value(tag) {
    if (values.has(tag)) return values.get(tag);
    const proxy = new Proxy(function () { return ready; }, { get(_target, key) {
      if (key === "tag") return tag;
      if (key === "then") return undefined;
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return () => tag;
      if (key === "N6") return () => null;
      if (key === "PM") return options => options.plugins;
      if (key === "LX") return options => options.apps ?? [];
      if (key === "Kj") return () => ({ ...ready, data: state.plugins });
      if (key === "XY") return () => ({ installPlugin: (plugin, options) => {
        calls.install.push({ plugin, hostId: options.hostId }); options.onSuccess?.();
      } });
      if (key === "JJ8") return () => false;
      if (key === "safeParse") return () => ({ success: false });
      if (key === "hE") return () => false;
      if (key === "xR") return (label, id) => `[${label}:${id}]`;
      if (key === "vt") return id => id;
      if (key === "zR") return descriptor => descriptor;
      return value(`${tag}.${String(key)}`);
    } });
    values.set(tag, proxy); return proxy;
  }
  const tag = key => typeof key === "function" ? key.tag : undefined;
  const scope = { value: { clientThreadId: null }, get(key) {
    if (tag(key)?.endsWith(".$e")) return state.composerText;
    return false;
  }, set(key, ...args) {
    if (key === bindings?.active) state.active = args.at(-1);
  }, query: {
    snapshot: () => ({ setData: update => { state.query.data = update(state.query.data); } }),
    setData: (_key, _ctx, data) => { state.query.data = data; }, invalidate() {},
  }, queryClient: { invalidateQueries() {} } };
  const composerScope = { ...scope };
  function get(key, input) {
    if (key === bindings.base) return state.query;
    if (key != null && typeof key === "object" && Object.hasOwn(key, "pref")) return key.pref.includes("source-debug") ? state.debug : key.initial;
    if (tag(key)?.endsWith(".$e")) return state.composerText;
    if (tag(key)?.endsWith(".lb")) return { data: state.apps };
    if (key?.kind === "un") return key.fn({ get });
    if (key?.kind === "i1") return key.fn(input, { get });
    return null;
  }
  function read(key, input, options) {
    calls.reads.push({ key: key?.id ?? tag(key), input, options });
    if (key === bindings.active) return state.active ?? null;
    if (key === bindings.mode) return "local";
    if (key?.kind === "i1") return key.fn(input, { get });
    if (input?.pluginIds != null) return { ...ready, data: [] };
    if (input?.hostId != null) return { ...ready, data: { roots: [] } };
    return { ...ready, data: null, isError: false };
  }
  function mutation(key) {
    return { isPending: false, mutate(input) {
      calls.mutations.push(input);
      const options = key.fn({ scope });
      options.onMutate?.(input);
      Promise.resolve(options.mutationFn(input)).then(result => options.onSuccess?.(result, input));
    } };
  }
  const imports = new Map();
  imports.set(binding(storeAlias), new Proxy({}, { get(_target, key) {
    if (key === "gh") return domain => {
      if (!domains.has(domain)) domains.set(domain, domain === bindings?.composerDomain ? composerScope : scope);
      return domains.get(domain);
    };
    if (key === "_U") return read;
    if (key === "Ul") return selector => selector?.kind === "aP" ? mutation(selector) : get(selector);
    return (...args) => atom(String(key), args);
  } }));
  imports.set(binding(memoAlias), { c: size => memo[memoIndex++] ??= Array(size).fill(Symbol.for("react.memo_cache_sentinel")) });
  imports.set(binding(reactAlias), { useRef: initial => refs[refIndex++] ??= { current: initial },
    useEffect(callback, deps) {
      const index = effectIndex++, previous = effectDeps[index];
      if (previous == null || deps.some((item, i) => !Object.is(item, previous[i]))) effects.push(callback);
      effectDeps[index] = deps;
    } });
  imports.set(binding(jsxAlias), { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) });
  imports.set(binding(runtimeAlias[1]), { [runtimeAlias[2]]: () => state.runtime });
  imports.set(binding(authAlias), { As: () => ({ authMethod: "chatgpt", accountId: "test-account", userId: "test-user", email: "test@example.test", isLoading: false }) });
  imports.set(binding(intlAlias), { A: () => ({ formatMessage: (message, args = {}) =>
    String(typeof message === "string" ? message : message?.defaultMessage ?? message?.id ?? "native-message")
      .replace(/\{(\w+)\}/g, (_match, name) => String(args[name] ?? name)), formatList: values => values.join(", ") }) });
  imports.set(binding(featureAlias), { Zj: id => id === "2716206584" && state.featureDiscovery,
    XR: () => false, Ou: () => ({ get: () => false }) });
  const composerModule = binding(composerCall[1]);
  imports.set(composerModule, new Proxy({}, { get(_target, key) {
    if (key === composerCall[2]) return (_scope, text) => { state.composerText = text; calls.composer.push(text); };
    return value(`${composerModule}.${String(key)}`);
  } }));
  imports.set(binding(focusCall[1]), { [focusCall[2]]: input => calls.focus.push(input.text) });
  const pref = /\(0,([\w$]+)\.m3\)\("electron:new-chat-suggestion-source-debug-override"/.exec(module.moduleSource)[1];
  imports.set(binding(pref), { m3: (key, initial) => ({ pref: key, initial }) });
  const provider = /\(0,([\w$]+)\.([\w$]+)\)\(\{debugOverride:[\w$]+,detectedProvider:[\w$]+\.data,emailDomain:[\w$]+,isError:[\w$]+\.isError\}\)/.exec(source);
  const providerModule = binding(provider[1]);
  imports.set(providerModule, new Proxy({}, { get(_target, key) {
    if (key === provider[2]) return () => "other";
    if (key === "rm") return () => "example.test";
    if (key === "H3") return name => name;
    return value(`${providerModule}.${String(key)}`);
  } }));
  // Resolve the native default-import bindings by their real array operations,
  // rather than pinning the Rspack ids or their short local aliases.
  const defaultImport = getter => {
    const loaded = new RegExp(`${escapeRegExp(getter)}=${escapeRegExp(module.params[2])}\\.n\\(([\\w$]+)\\)`).exec(module.moduleSource);
    assert.ok(loaded);
    return binding(loaded[1]);
  };
  const findGetter = /([\w$]+)\(\)\([\w$]+,\(\{id:[\w$]+\}\)=>/.exec(module.moduleSource)[1];
  const uniqueGetter = /\?([\w$]+)\(\)\(\[\.\.\./.exec(source)[1];
  imports.set(defaultImport(findGetter), (items, predicate) => items.find(predicate));
  imports.set(defaultImport(uniqueGetter), (items, key) => [...new Map(items.map(item => [key(item), item])).values()]);
  const policyQuery = /\(0,([\w$]+)\.([\w$]+)\)\(([\w$]+)\)\}function/.exec(policyModule.moduleSource);
  const policyQueryAlias = policyQuery[1];
  const policyQueryId = findRspackRequireBinding(policyModule, policyQueryAlias).moduleId;
  imports.set(policyQueryId, { [policyQuery[2]]: options => { calls.connectedQueries.push(options); return { data: state.hasEnabledApps, isLoading: state.accessLoading }; } });
  const serviceAlias = /([\w$]+)\.appServices\.ambientSuggestions/.exec(policyModule.moduleSource)[1];
  const serviceId = findRspackRequireBinding(policyModule, serviceAlias).moduleId;
  imports.set(serviceId, { appServices: { ambientSuggestions: { setStatus: async () => state.query.data } } });
  const load = id => imports.get(id) ?? value(id);
  load.d = (target, getters, values) => {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get });
    Object.assign(target, values);
  };
  load.n = module => () => module;
  const globals = { DOMException };
  function execute(snapshot, suffix = "") {
    return vm.runInNewContext(`(function(${snapshot.params.join(",")}){${snapshot.moduleSource};${suffix}})`, globals,
      { filename: "native-home-content.js", displayErrors: false })({}, {}, load);
  }
  const policyExports = {};
  vm.runInNewContext(`(function(${policyModule.params.join(",")}){${policyModule.moduleSource}})`, globals,
    { filename: "native-home-policy.js", displayErrors: false })({}, policyExports, load);
  imports.set(binding(policyAlias), policyExports);
  const result = execute(module, `return {Content:${owner.name},active:${reads[0][3]},generated:${reads[1][3]},settled:${reads[2][3]},statuses:${reads[3][3]},mode:${reads[4][3]},base:${base},debug:${debugToken},composerDomain:${scopes[1][2]}}`);
  bindings = result;
  return { state, calls, render(props = {}) {
    memoIndex = refIndex = effectIndex = 0;
    const node = result.Content({ ambientSuggestionSurface: "codex", domain: "test-domain", generatedSuggestionsEnabled: true,
      hostId: "local", isCodexHome: true, plan: "plus", projectRoot: "/project", selectedModel: "test-model", ...props });
    effects.splice(0).forEach(callback => callback());
    return node;
  } };
}

let signedInputs;
function currentSignedContent() {
  if (signedInputs != null) return signedInputs;
  const original = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
  const copies = findUniqueRspackModuleCopies(original, { sourceMatch: source => source.includes("HomeAmbientSuggestionsContent:"),
    matchModule: source => source.includes("HomeAmbientSuggestionsContent:") });
  const copy = copies[0], modules = [...rspackModuleFactories(copy.source, copy.assetName)];
  const policyAlias = /\(0,([\w$]+)\.[\w$]+\)\(\{canUsePersonalizedSuggestions:/.exec(contentOwner(copy).source)[1];
  const policy = modules.find(module => module.moduleId === findRspackRequireBinding(copy, policyAlias).moduleId);
  assert.ok(policy);
  return signedInputs = { original, copies, copy, policy };
}
function proposal(id, prompt, extra = {}) {
  return { id, title: `next ${id}`, prompt, description: "A next step", status: "pending", appIds: [],
    createdAtMs: 0, updatedAtMs: 0, ...extra };
}
function queryData(items) {
  return { data: { file: { currentSuggestionIds: items.map(item => item.id), suggestions: items } }, isError: false };
}
function view(node) {
  return node == null ? null : { items: node.props.supplementalItems.map(item => ({ id: item.id, label: item.label })),
    categories: node.props.categories.map(category => category.id), layout: node.props.topLevelLayout, disabled: node.props.disabled };
}

test("actual signed content keeps runtime-off fallback and sends a generated card through its native composer callback", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async t => {
  const { original, copies, copy, policy } = currentSignedContent();
  const app = workspace(t, Object.fromEntries(copies.map(copy => [copy.assetName, copy.source])));
  assert.equal(app.run().status, "applied");
  assert.equal(app.run().status, "already-applied");
  const patched = [...rspackModuleFactories(app.read(copy.assetName), copy.assetName)].find(module => module.moduleId === copy.moduleId);
  assert.equal(javascriptSourceParses(app.read(copy.assetName)), true);
  const flag = /let ([\w$]+)="curated"===([\w$]+);/.exec(contentOwner(copy).source);
  const enabled = /[\w$]+=[\w$]+&&null!=[\w$]+,([\w$]+)=null==[\w$]+&&[\w$]+&&[\w$]+/.exec(contentOwner(copy).source)[1];
  assert.equal(app.read(copy.assetName).replace(`let ${flag[1]}="curated"===${flag[2]}&&!${enabled}/*${marker}*/;`, flag[0]), copy.source,
    "the native policy, selectors, loading paths, plugin filtering and card callbacks remain byte-identical");
  const item = proposal("next-action", "Review the current project changes");
  const offBefore = nativeHarness(copy, policy, { runtime: false }), offAfter = nativeHarness(patched, policy, { runtime: false });
  assert.ok(offBefore.render({ projectRoot: null }));
  assert.ok(offAfter.render({ projectRoot: null }));
  const harness = nativeHarness(patched, policy, { query: queryData([item]) });
  const node = harness.render();
  assert.ok(node);
  assert.equal(harness.calls.composer.length, 0);
  assert.equal(node.props.supplementalItems.length, 1);
  node.props.supplementalItems[0].onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.calls.composer, [item.prompt]);
  assert.deepEqual(harness.calls.focus, [item.prompt]);
  for (const originalCopy of copies) assert.equal(fs.readFileSync(path.join(original, originalCopy.assetName), "utf8"), originalCopy.source);
  const flagName = /shouldUseCuratedNewChatPageSuggestions:([\w$]+)/.exec(contentOwner(copy).source)[1];
  const requireName = copy.params[2], exportsName = copy.params[1];
  const registration = new RegExp(`${escapeRegExp(requireName)}\\.d\\(${escapeRegExp(exportsName)},\\{HomeAmbientSuggestionsContent:\\(\\)=>[\\w$]+\\}\\)`).exec(copy.moduleSource)[0];
  const patchedChunk = app.read(copy.assetName);
  const negative = [
    [false, copy.source.replace(`shouldUseCuratedNewChatPageSuggestions:${flagName}`, 'shouldUseCuratedNewChatPageSuggestions:wrongFlag')],
    [true, patchedChunk.replace(/&&![\w$]+\/\*codexLinuxSuggestedPromptsGeneratedSource\*\//, `&&!wrongQuery/*${marker}*/`)],
    ...Object.values(exportVariants(registration, requireName, exportsName)).flatMap(replacement => [
      [false, copy.source.replace(registration + ";", replacement)],
      [true, patchedChunk.replace(registration + ";", replacement)],
    ]),
  ];
  t.mock.method(console, "warn", () => {});
  for (const [applied, damaged] of negative) {
    assert.equal(javascriptSourceParses(damaged), true);
    for (const originalCopy of copies) fs.writeFileSync(path.join(app.root, "webview/assets", originalCopy.assetName),
      applied ? apply(originalCopy.source) : originalCopy.source);
    fs.writeFileSync(path.join(app.root, "webview/assets", copy.assetName), damaged);
    assert.equal(app.run().status, "skipped-optional");
    assert.equal(app.read(copy.assetName), damaged);
  }
  assert.equal(fs.readFileSync(path.join(original, copy.assetName), "utf8"), copy.source);
});

test("actual native policy/content preserves disabled contexts and loading/error/empty/reentry/project flows", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const { copy, policy } = currentSignedContent();
  const patched = [...rspackModuleFactories(apply(copy.source), copy.assetName)].find(module => module.moduleId === copy.moduleId);
  for (const surface of ["codex", "chatgpt_work"]) for (const runtime of [false, true]) for (const page of [false, true]) for (const projectRoot of [null, "/project"]) {
    if (runtime && page && projectRoot != null) continue;
    const options = { runtime, query: queryData([proposal("cached", "Cached proposal")]) };
    const before = nativeHarness(copy, policy, options), after = nativeHarness(patched, policy, options);
    const props = { ambientSuggestionSurface: surface, generatedSuggestionsEnabled: page, projectRoot };
    const beforeNode = before.render(props), afterNode = after.render(props);
    assert.ok(beforeNode);
    assert.ok(afterNode);
    assert.equal(JSON.stringify(view(afterNode)), JSON.stringify(view(beforeNode)));
    assert.equal(after.calls.composer.length, 0);
    assert.equal(after.calls.mutations.length, 0);
  }
  for (const debug of ["curated", "generated"]) {
    const options = { debug, query: queryData([proposal("override", "Explicit override")]) };
    const before = nativeHarness(copy, policy, options), after = nativeHarness(patched, policy, options);
    assert.equal(JSON.stringify(view(after.render())), JSON.stringify(view(before.render())));
  }
  const work = nativeHarness(patched, policy, { query: queryData([proposal("work", "Work proposal")]) });
  assert.deepEqual(Array.from(work.render({ ambientSuggestionSurface: "chatgpt_work" }).props.supplementalItems, item => item.id), ["work"]);
  for (const options of [
    { query: { data: undefined, isError: false } },
    { query: { data: undefined, isError: true } },
    { query: queryData([]) },
    { accessLoading: true, query: queryData([proposal("loading", "Not ready")]) },
  ]) {
    const harness = nativeHarness(patched, policy, options);
    assert.equal(harness.render(), null);
    assert.equal(harness.calls.composer.length, 0);
    assert.equal(harness.calls.mutations.length, 0);
  }
  const harness = nativeHarness(patched, policy, { query: { data: undefined, isError: true } });
  assert.equal(harness.render(), null);
  harness.state.query = queryData([proposal("alpha", "Alpha proposal")]);
  assert.deepEqual(Array.from(harness.render({ projectRoot: "/alpha", hostId: "ssh-a" }).props.supplementalItems, item => item.id), ["alpha"]);
  harness.state.query = queryData([proposal("beta", "Beta proposal")]);
  const beta = harness.render({ projectRoot: "/beta", hostId: "ssh-b" });
  assert.deepEqual(Array.from(beta.props.supplementalItems, item => item.id), ["beta"]);
  assert.ok(harness.calls.connectedQueries.at(-1).queryKey.includes("ssh-b"));
  assert.equal(harness.calls.connectedQueries.at(-1).enabled, true);
  assert.equal(harness.calls.composer.length, 0);
  beta.props.supplementalItems[0].onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.calls.composer, ["Beta proposal"]);
  assert.equal(harness.calls.mutations[0].hostId, "ssh-b");
  assert.equal(harness.calls.mutations[0].projectRoot, "/beta");
  assert.equal(harness.calls.mutations[0].suggestionId, "beta");
  harness.render({ projectRoot: "/beta", hostId: "ssh-b" });
  assert.equal(harness.calls.composer.length, 1, "rerender never fills the composer again");
  const reentered = nativeHarness(patched, policy, { query: harness.state.query });
  assert.equal(reentered.render({ projectRoot: "/beta", hostId: "ssh-b" }), null, "accepted native suggestions are not replayed on reentry");
  assert.equal(reentered.calls.composer.length, 0);
});

test("actual generated-card filtering preserves connected-plugin eligibility and native onboarding/composer actions", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const { copy, policy } = currentSignedContent();
  const patched = [...rspackModuleFactories(apply(copy.source), copy.assetName)].find(module => module.moduleId === copy.moduleId);
  const generic = proposal("generic", "Local project proposal");
  const connected = proposal("connected", "Draft a connected note", { appIds: ["docs"], pluginMention: { id: "docs@community", label: "Docs" } });
  const plugin = { plugin: { id: "docs@community", name: "Docs", availability: "AVAILABLE", installed: true, enabled: true } };
  for (const options of [
    { plugins: [] },
    { plugins: [{ plugin: { ...plugin.plugin, enabled: false } }] },
    { plugins: [{ plugin: { ...plugin.plugin, availability: "UNAVAILABLE" } }] },
    { plugins: [plugin], featureDiscovery: false },
  ]) {
    const harness = nativeHarness(patched, policy, { ...options, query: queryData([generic, connected]) });
    assert.deepEqual(Array.from(harness.render().props.supplementalItems, item => item.id), ["generic"]);
    assert.equal(harness.calls.composer.length, 0);
  }
  for (const installed of [true, false]) {
    const harness = nativeHarness(patched, policy, { query: queryData([connected]),
      plugins: [{ plugin: { ...plugin.plugin, installed } }], apps: [{ id: "docs", name: "Docs" }] });
    const node = harness.render({ hostId: "ssh-connected", projectRoot: "/connected" });
    assert.deepEqual(Array.from(node.props.supplementalItems, item => item.id), ["connected"]);
    assert.equal(harness.calls.composer.length, 0);
    node.props.supplementalItems[0].onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.calls.composer, ["[@Docs:docs@community] Draft a connected note"]);
    assert.equal(harness.calls.focus.length, 1);
    assert.equal(harness.calls.install.length, installed ? 0 : 1);
    if (!installed) assert.equal(harness.calls.install[0].hostId, "ssh-connected");
  }
});
