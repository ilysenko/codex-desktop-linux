"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { descriptors } = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { findWebviewAssetsContaining, patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { patchBreaksJavaScriptSyntax } = require("../../scripts/patches/lib/javascript-syntax.js");
const { STORAGE_KEY, RUNTIME, reasoningVisibilitySnapshot } = require("./runtime.js");
const { MESSAGE_IDS, translations, settingsContract, settingComponent, catalogPatches, patchSettingsSource, applySettingsPatch } = require("./settings.js");

// Current signed rspack/SWC shapes: double-quoted strings, literal-first
// comparisons and the transcript key as the only template literal.
const standaloneSource = 'function classify(e,{includeGeneratedImages:n=!1}={}){switch(e.type){case"exec":return wrap(e,"groupable");case"generated-image":return n?wrap(e,"standalone"):null;case"worktree-init":return wrap(e,"standalone");case"reasoning":case"automation-update":case"todo-list":return null}}function wrap(e,t){return{item:e,grouping:t}}';
const persistentSource = 'function persistent({unit:e,hasFollowingFinalAnswer:t}){if("standalone"!==e.kind)return!1;let a=e.item.item;return"user-input-response"===a.type?!a.completed:"assistant-message"===a.type&&a.important?!0:"user-message"===a.type&&!t}const partition={collapsibleUnits:[],persistentUnits:[]};';
const transcriptSource = 'function transcript(items,n){let i=[],a=[],s=()=>{a.length&&(i.push({type:"agent-activity",items:a,collapseWhenPossible:!0}),a=[])};for(let o of items){let l="reasoning"===o.type?null:{grouping:o.grouping};if(l?.grouping==="standalone"||n?.has(o)===!0){s(),i.push({type:"activity-item",key:`transcript-activity-item-${o.id}`,item:o});continue}a.push(o)}s();return i}';
const summariesSource = 'function options(client,mode){return{reasoningSummaryOverride:!0===client.getDefaultFeatureOverride("concurrent_reasoning_summaries")||mode?"detailed":null,getRequestModel:e=>e,getRequestCollaborationMode(e){return e}}}function resolve(options,config,turn){let summary="none";null!=options.reasoningSummaryOverride&&(summary=options.reasoningSummaryOverride);summary=config.model_reasoning_summary??summary;void 0!==turn.summary&&(summary=turn.summary);return summary}';
const expandedSource = 'function reasoning(e){let{item:n}=e,l=!n.completed,f=n.content,[h,g]=(0,React.useState)(!1),_=!l&&!!f;let v=n.content;let y=v,b=l?!!y:h,x=l?y:f,disclosure={expanded:h,onToggle:()=>{g(toggle)}},scroll={items:[{key:"reasoning-markdown",node:x}],autoScrollToBottom:l,viewState:"expanded"};return{visible:b,disclosure,scroll}}function toggle(e){return!e}';
const sources = [standaloneSource, persistentSource, transcriptSource, summariesSource, expandedSource];
const preference = (enabled = true) => ({ localStorage: { getItem: () => enabled ? "1" : null } });

function warnings(fn) {
  const saved = console.warn, messages = [];
  console.warn = (message) => messages.push(message);
  try { return { value: fn(), messages }; } finally { console.warn = saved; }
}

function patched(index, source = sources[index]) {
  const result = descriptors[index].apply(source);
  assert.notEqual(result, source);
  const repeated = warnings(() => descriptors[index].apply(result));
  assert.equal(repeated.value, result);
  assert.deepEqual(repeated.messages, []);
  new vm.Script(result);
  return result;
}

test("feature stays disabled until explicitly selected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-config-"));
  try {
    const featuresConfigPath = path.join(dir, "features.json");
    for (const enabled of [[], ["reasoning-visibility"]]) {
      fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled }));
      const selected = loadLinuxFeaturePatchDescriptors({ featuresConfigPath })
        .filter((d) => d.featureId === "reasoning-visibility");
      assert.equal(selected.length, enabled.length === 0 ? 0 : 6);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reasoning becomes standalone while tools, images and hidden events retain their behavior", () => {
  const original = vm.runInNewContext(standaloneSource + ';classify');
  const classify = vm.runInNewContext(patched(0) + ';classify', preference());
  for (const completed of [false, true]) {
    const item = { type: "reasoning", content: "Available summary", completed };
    assert.equal(original(item), null);
    assert.equal(classify(item).item, item);
    assert.equal(classify(item).grouping, "standalone");
  }
  for (const type of ["exec", "generated-image", "automation-update", "todo-list", "worktree-init"]) {
    for (const includeGeneratedImages of [false, true]) {
      const item = { type }, options = { includeGeneratedImages };
      assert.equal(JSON.stringify(classify(item, options)), JSON.stringify(original(item, options)));
    }
  }
});

test("reasoning stays persistent after a final answer without changing other activity classification", () => {
  const original = vm.runInNewContext(persistentSource + ';persistent');
  const persistent = vm.runInNewContext(patched(1) + ';persistent', preference());
  const unit = (item) => ({ kind: "standalone", item: { item } });
  for (const completed of [false, true]) {
    assert.equal(persistent({ unit: unit({ type: "reasoning", completed }), hasFollowingFinalAnswer: true }), true);
  }
  assert.equal(persistent({ unit: { kind: "group" } }), false);
  for (const type of ["exec", "assistant-message", "user-message", "user-input-response"]) {
    for (const completed of [false, true]) for (const following of [false, true]) {
      const input = { unit: unit({ type, completed }), hasFollowingFinalAnswer: following };
      assert.equal(persistent(input), original(input));
    }
  }
});

test("transcript separates reasoning from surrounding tools and preserves order and identity", () => {
  const transcript = vm.runInNewContext(patched(2) + ';transcript', preference());
  const items = [
    { id: 1, type: "exec", grouping: "groupable" },
    { id: 2, type: "reasoning", completed: true },
    { id: 3, type: "exec", grouping: "groupable" },
    { id: 4, type: "reasoning", completed: false },
  ];
  const result = transcript(items);
  assert.equal(JSON.stringify(result.map((entry) => entry.type)), JSON.stringify(["agent-activity", "activity-item", "agent-activity", "activity-item"]));
  assert.equal(result[1].item, items[1]);
  assert.equal(result[3].item, items[3]);
  assert.equal(result[0].items[0], items[0]);
  assert.equal(result[2].items[0], items[2]);
});

test("requests detailed summaries while explicit config and per-turn choices still win", () => {
  const { options, resolve } = vm.runInNewContext(patched(3) + ';({options,resolve})', preference());
  const defaults = options({ getDefaultFeatureOverride: () => false }, false);
  assert.equal(defaults.reasoningSummaryOverride, "detailed");
  assert.equal(resolve(defaults, {}, {}), "detailed");
  assert.equal(resolve(defaults, { model_reasoning_summary: "none" }, {}), "none");
  assert.equal(resolve(defaults, { model_reasoning_summary: "concise" }, {}), "concise");
  assert.equal(resolve(defaults, {}, { summary: "none" }), "none");
  assert.equal(defaults.getRequestModel("example"), "example");
});

test("reasoning starts expanded, survives completion and supports manual collapse and reopen", () => {
  let state;
  const React = { useState(initial) {
    state ??= initial;
    return [state, (next) => { state = typeof next === "function" ? next(state) : next; }];
  } };
  const render = vm.runInNewContext(patched(4) + ';reasoning', { React, ...preference() });
  const item = { completed: false, content: "Available reasoning summary" };
  assert.equal(render({ item }).visible, true);
  item.completed = true;
  let result = render({ item });
  assert.equal(result.visible, true);
  assert.equal(result.scroll.items[0].node, item.content);
  result.disclosure.onToggle();
  result = render({ item });
  assert.equal(result.visible, false);
  result.disclosure.onToggle();
  assert.equal(render({ item }).visible, true);
});

test("all contracts tolerate fresh minified identifiers and fail closed on missing or duplicate targets", () => {
  for (const [index, source] of sources.entries()) {
    const renamed = source.replace(/\be\b/g, "inputArg").replace(/\bn\b/g, "optionsArg").replace(/\bh\b/g, "$expanded");
    patched(index, renamed);
    for (const invalid of ["const unrelated=1;", source + source, patched(index) + source]) {
      const result = warnings(() => descriptors[index].apply(invalid));
      assert.equal(result.value, invalid);
      assert.equal(result.messages.length, 1);
    }
  }
});

test("incomplete native disclosure is preserved instead of patching a neighboring state hook", () => {
  for (const source of [expandedSource.replace("autoScrollToBottom:l", "autoScrollToBottom:!1"),
    expandedSource.replace("onToggle:()=>{g(toggle)}", "onToggle:handleToggle")]) {
    const result = warnings(() => descriptors[4].apply(source));
    assert.equal(result.value, source);
    assert.equal(result.messages.length, 1);
  }
});

test("a marker with an inconsistent transcript item is not accepted as patched", () => {
  const corrupted = patched(2).replace('"reasoning"===o.type||/*community-reasoning-visibility-transcript*/',
    '"reasoning"===other.type||/*community-reasoning-visibility-transcript*/');
  assert.notEqual(corrupted, patched(2));
  const result = warnings(() => descriptors[2].apply(corrupted));
  assert.equal(result.value, corrupted);
  assert.equal(result.messages.length, 1);
});

test("content-addressed selection patches every chunk copy and reports needle-only drift", () => {
  for (const [index, descriptor] of descriptors.slice(0, 5).entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-assets-"));
    try {
      const assets = path.join(root, "webview/assets/async");
      fs.mkdirSync(assets, { recursive: true });
      const apply = () => warnings(() => patchAssetFiles(root, null, descriptor.apply, "missing",
        findWebviewAssetsContaining(root, descriptor.assetNeedles)));
      fs.writeFileSync(path.join(assets, "298814.3fa7f076e4.js"), sources[index]);
      assert.equal(apply().value.changed, 1, descriptor.id);
      assert.deepEqual(apply(), { value: { matched: 1, changed: 0, changedAssets: [] }, messages: [] }, descriptor.id);
      // rspack can duplicate one module into several async chunks.
      fs.writeFileSync(path.join(assets, "899308.3f1db3f4cb.js"), sources[index]);
      assert.deepEqual(apply().value.changedAssets, ["async/899308.3f1db3f4cb.js"], descriptor.id);
      fs.writeFileSync(path.join(assets, "100.0000000000.js"), descriptor.assetNeedles.join(";"));
      const drift = apply();
      assert.equal(drift.value.changed, 0, descriptor.id);
      assert.equal(drift.messages.length, 1, descriptor.id);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("disabled preference restores upstream classification, grouping and summary requests", () => {
  const item = { type: "reasoning", content: "Summary", completed: true };
  const classify = vm.runInNewContext(patched(0) + ';classify', preference(false));
  assert.equal(classify(item), null);
  const persistent = vm.runInNewContext(patched(1) + ';persistent', preference(false));
  assert.equal(persistent({ unit: { kind: "standalone", item: { item } } }), false);
  const project = vm.runInNewContext(patched(2) + ';transcript', preference(false));
  assert.equal(project([item])[0].type, "agent-activity");
  const { options } = vm.runInNewContext(patched(3) + ';({options})', preference(false));
  assert.equal(options({ getDefaultFeatureOverride: () => false }, false).reasoningSummaryOverride, null);
  assert.equal(options({ getDefaultFeatureOverride: () => true }, false).reasoningSummaryOverride, "detailed");
  assert.equal(options({ getDefaultFeatureOverride: () => false }, true).reasoningSummaryOverride, "detailed");
});

function storage(initial) {
  const data = new Map(initial == null ? [] : [[STORAGE_KEY, initial]]);
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("preference is off by default and fixed across lazy chunks until the next renderer session", () => {
  const localStorage = storage(), scope = { localStorage };
  assert.equal(reasoningVisibilitySnapshot(scope), false);
  localStorage.setItem(STORAGE_KEY, "1");
  assert.equal(reasoningVisibilitySnapshot(scope), false);
  const nextSession = { localStorage };
  assert.equal(reasoningVisibilitySnapshot(nextSession), true);
  localStorage.setItem(STORAGE_KEY, "0");
  assert.equal(reasoningVisibilitySnapshot(nextSession), true);
  assert.equal(reasoningVisibilitySnapshot({ localStorage }), false);
  const context = vm.createContext({ localStorage });
  vm.runInContext(RUNTIME, context);
  localStorage.setItem(STORAGE_KEY, "1");
  vm.runInContext(RUNTIME, context); // A later chunk shares the startup snapshot.
  assert.equal(vm.runInContext("codexLinuxReasoningVisibilityEnabled()", context), false);
});

test("invalid or inaccessible storage safely leaves the feature off", () => {
  for (const value of [undefined, "true", "false", "0", "yes", ""]) {
    assert.equal(reasoningVisibilitySnapshot({ localStorage: storage(value) }), false);
  }
  assert.equal(reasoningVisibilitySnapshot({ get localStorage() { throw Error("denied"); } }), false);
});

// Current signed shape: the General settings module factory declares React,
// JSX, the row, switch, platform and locale hooks as factory-scope imports.
function settingsFixture() {
  return 'export const __rspack_esm_id=572868;export const __rspack_esm_ids=[572868];export const __webpack_modules__={G3wX(e,t,a){a.d(t,{GeneralSettings:()=>page});' +
    'var n=a("ABep"),r=a("QosV"),m=a("zd8w"),P=a("AWNZ"),N=a("F0xz"),ed=a("ed00"),b=a("bb00"),F=a("RxZZ"),f=a("ff00");' +
    'function menu(e){let c=(0,r.c)(15),{appName:d}=e,h=(0,b.A)(),{platform:p}=(0,ed.V)(),v=(0,F.iK)(f.U6S.macMenuBarEnabled);if("macOS"!==p)return null;' +
    'let label=h.formatMessage({id:"settings.general.macMenuBar.ariaLabel"},{appName:d});let o=(0,n.jsx)(N.l,{checked:v,onChange:change,ariaLabel:label});' +
    'return(0,n.jsx)(P.ic,{label:label,description:d,control:o})}function change(){}function another(){let[e,t]=(0,m.useState)(!1)}' +
    'function page(){return(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(menu,{appName:"ChatGPT"}),(0,n.jsx)(N.l,{}),(0,n.jsx)(menu,{appName:f.C})]})}' +
    '/*settings.general.macMenuBar.description*/},ABep(e,t,a){e.exports={}}};';
}

const catalogKey = (locale) => `K${locale.replace(/-/g, "_")}`;
const catalogChunk = (locale) => 100000 + Object.keys(translations).indexOf(locale);

function catalogFixture(locale) {
  return `export const __rspack_esm_id=${catalogChunk(locale)};export const __webpack_modules__={${catalogKey(locale)}(e){e.exports=JSON.parse('{"settings.general.macMenuBar.label":"Existing","unrelated":"Unchanged","quoted":"l\\'accès \\\\"x\\\\""}')}};`;
}

function loaderFixture(locales) {
  const entries = locales.map((locale) => `"../locales/${locale}.json":function(){return i.e(${catalogChunk(locale)}).then(i.t.bind(i,"${catalogKey(locale)}",19))}`);
  return `export const __webpack_modules__={Lc1(e,t,i){let o={${entries.join(",")}}}};`;
}

async function catalogMessages(source, locale) {
  const { __webpack_modules__: modules } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const module = {};
  modules[catalogKey(locale)](module);
  return module.exports;
}

function settingsHarness({ locale = "en", localStorage = storage(), platform = "linux" } = {}) {
  const values = [], events = new Map();
  let index = 0;
  const React = { useState(initial) {
    const current = index++;
    if (!(current in values)) values[current] = typeof initial === "function" ? initial() : initial;
    return [values[current], (next) => { values[current] = typeof next === "function" ? next(values[current]) : next; }];
  }, useEffect(callback) { callback(); } };
  const context = {
    localStorage, m: React, ed: { V: () => ({ platform }) },
    b: { A: () => ({ formatMessage: ({ id, defaultMessage }) => translations[locale]?.[MESSAGE_IDS.indexOf(id)] ?? defaultMessage }) },
    P: { ic: "row" }, N: { l: "toggle" }, n: { jsx: (type, props) => ({ type, props }) },
    window: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: (name) => events.delete(name) },
  };
  const render = vm.runInNewContext(settingComponent(settingsContract(settingsFixture())) + ';codexLinuxReasoningVisibilitySetting', context);
  return { localStorage, events, render() { index = 0; return render(); } };
}

test("native settings toggle saves both choices and a fresh renderer honors the saved value", () => {
  const harness = settingsHarness();
  let row = harness.render();
  assert.equal(row.props.control.props.checked, false);
  row.props.control.props.onChange(true);
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), "1");
  assert.equal(harness.render().props.control.props.checked, true);
  assert.equal(settingsHarness({ localStorage: harness.localStorage }).render().props.control.props.checked, true);
  assert.equal(reasoningVisibilitySnapshot({ localStorage: harness.localStorage }), true);
  harness.render().props.control.props.onChange(false);
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), "0");
  assert.equal(reasoningVisibilitySnapshot({ localStorage: harness.localStorage }), false);
});

test("all setting labels, descriptions, accessible labels and save errors use the active locale", () => {
  assert.equal(Object.keys(translations).length, 65);
  for (const [locale, messages] of Object.entries(translations)) {
    assert.equal(messages.length, MESSAGE_IDS.length, locale);
    assert.ok(messages.every((message) => typeof message === "string" && message.trim()), locale);
    const harness = settingsHarness({ locale, localStorage: {
      getItem: () => null, setItem: () => { throw Error("private browser error"); },
    } });
    const row = harness.render();
    assert.equal(row.props.label, messages[0], locale);
    assert.equal(row.props.control.props.ariaLabel, messages[0], locale);
    assert.equal(row.props.description, messages[1], locale);
    row.props.control.props.onChange(true);
    assert.equal(harness.render().props.description, messages[2], locale);
    assert.equal(harness.render().props.control.props.checked, false, locale);
  }
});

test("setting is Linux-only and reflects preference changes from another window", () => {
  assert.equal(settingsHarness({ platform: "macOS" }).render(), null);
  const harness = settingsHarness();
  harness.render();
  harness.localStorage.setItem(STORAGE_KEY, "1");
  harness.events.get("storage")({ key: STORAGE_KEY });
  assert.equal(harness.render().props.control.props.checked, true);
});

function settingsTree(t, locales = ["pl-PL", "es-419"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets/async");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "572868.36a6c86221.js"), settingsFixture());
  fs.writeFileSync(path.join(assets, "496175.cf5ad221c1.js"), loaderFixture(locales));
  const catalog = (locale) => path.join(assets, `${catalogChunk(locale)}.0123456789.js`);
  for (const locale of locales) fs.writeFileSync(catalog(locale), catalogFixture(locale));
  return { root, assets, catalog, settingsPath: path.join(assets, "572868.36a6c86221.js") };
}

test("native row and all 64 locale catalogs patch idempotently while existing messages stay unchanged", async (t) => {
  const locales = Object.keys(translations).filter((locale) => locale !== "en");
  const { root, catalog, settingsPath } = settingsTree(t, locales);
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  assert.deepEqual(applySettingsPatch(root), { changed: false });
  const settings = fs.readFileSync(settingsPath, "utf8");
  assert.equal(settings.split("(0,n.jsx)(codexLinuxReasoningVisibilitySetting,{}),(0,n.jsx)(menu,{appName:").length, 3);
  assert.match(settings, /return\(0,n\.jsx\)\(P\.ic,\{label:label,description:d,control:o\}\)\}function codexLinuxReasoningVisibilitySetting\(\)\{let React=m,\{platform\}=\(0,ed\.V\)\(\)/);
  await import(`data:text/javascript,${encodeURIComponent(settings)}`);
  for (const locale of locales) {
    const messages = await catalogMessages(fs.readFileSync(catalog(locale), "utf8"), locale);
    assert.equal(messages.unrelated, "Unchanged");
    assert.equal(messages.quoted, 'l\'accès "x"');
    assert.equal(messages["settings.general.macMenuBar.label"], "Existing");
    assert.equal(Object.keys(messages).length, 6);
    for (const [index, id] of MESSAGE_IDS.entries()) assert.equal(messages[id], translations[locale][index], locale);
  }
});

test("missing translations or a partial catalog fail before writing settings or any catalog", (t) => {
  const { root, assets, catalog, settingsPath } = settingsTree(t);
  const originalSettings = fs.readFileSync(settingsPath, "utf8");
  const catalogPath = catalog("pl-PL"), originalCatalog = fs.readFileSync(catalogPath, "utf8");
  const loaderPath = path.join(assets, "496175.cf5ad221c1.js");
  fs.writeFileSync(loaderPath, loaderFixture(["pl-PL", "es-419", "zz"]));
  fs.writeFileSync(catalog("zz"), catalogFixture("zz"));
  assert.throws(() => applySettingsPatch(root), /missing translations for zz/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), originalCatalog);
  fs.writeFileSync(loaderPath, loaderFixture(["pl-PL", "es-419"]));
  const partial = originalCatalog.replace(`{"settings.general`, `{"settings.general.reasoningVisibility.label":"Partial","settings.general`);
  fs.writeFileSync(catalogPath, partial);
  assert.throws(() => applySettingsPatch(root), /incomplete or inconsistent/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), partial);
  fs.writeFileSync(catalogPath, originalCatalog);
  fs.rmSync(catalog("es-419"));
  assert.throws(() => applySettingsPatch(root), /es-419 translation catalog missing or ambiguous/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
});

test("settings contract drift, foreign module aliases and duplicate assets fail closed", (t) => {
  const { root, assets, catalog, settingsPath } = settingsTree(t);
  fs.writeFileSync(settingsPath, settingsFixture().replace("onChange:change", "onChange:()=>change()"));
  assert.throws(() => applySettingsPatch(root), /native General setting contract/);
  assert.equal(fs.readFileSync(catalog("pl-PL"), "utf8"), catalogFixture("pl-PL"));
  // React must be imported by the owner's own module factory.
  fs.writeFileSync(settingsPath, settingsFixture().replace('m=a("zd8w"),', ""));
  assert.throws(() => applySettingsPatch(root), /native General setting contract/);
  fs.writeFileSync(settingsPath, settingsFixture());
  fs.writeFileSync(path.join(assets, "1.0000000000.js"), settingsFixture());
  assert.throws(() => applySettingsPatch(root), /asset missing or ambiguous/);
});

const tray = require("../start-minimized-to-tray/patch.js");
test("General setting and catalogs compose idempotently with the optional tray settings", {
  skip: tray.settingsContract(settingsFixture()) == null && "start-minimized-to-tray does not recognize the rspack settings module",
}, (t) => {
  const { root } = settingsTree(t);
  assert.deepEqual(tray.applySettingsPatch(root), { changed: true });
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  assert.deepEqual(tray.applySettingsPatch(root), { changed: false });
  assert.deepEqual(applySettingsPatch(root), { changed: false });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview contracts patch every copy once and stay valid JavaScript", { skip: !signedApp }, () => {
  for (const descriptor of descriptors.slice(0, 5)) {
    const names = findWebviewAssetsContaining(signedApp, descriptor.assetNeedles);
    assert.ok(names.length >= 1, descriptor.id);
    for (const name of names) {
      const source = fs.readFileSync(path.join(signedApp, "webview/assets", name), "utf8");
      const result = warnings(() => descriptor.apply(source));
      assert.deepEqual(result.messages, [], `${descriptor.id} ${name}`);
      assert.notEqual(result.value, source, `${descriptor.id} ${name}`);
      assert.equal(descriptor.apply(result.value), result.value, `${descriptor.id} ${name}`);
      assert.equal(patchBreaksJavaScriptSyntax(source, result.value), false, `${descriptor.id} ${name}`);
    }
  }
});

test("official signed General settings module and all locale catalogs satisfy the contract", { skip: !signedApp }, () => {
  const { listWebviewScriptAssets } = require("../../scripts/patches/lib/assets.js");
  const assetsDir = path.join(signedApp, "webview/assets");
  const [settingsName, ...extraSettings] = findWebviewAssetsContaining(signedApp, ["settings.general.macMenuBar.description", ".macMenuBarEnabled"]);
  assert.deepEqual(extraSettings, []);
  const source = fs.readFileSync(path.join(assetsDir, settingsName), "utf8");
  assert.equal(settingsContract(source).renders.length, 2);
  const patchedSettings = patchSettingsSource(source);
  assert.equal(patchSettingsSource(patchedSettings), patchedSettings);
  const [loaderName, ...extraLoaders] = findWebviewAssetsContaining(signedApp, ['"../locales/pl-PL.json":function(){return ']);
  assert.deepEqual(extraLoaders, []);
  const catalogs = catalogPatches(assetsDir, listWebviewScriptAssets(signedApp), fs.readFileSync(path.join(assetsDir, loaderName), "utf8"));
  assert.equal(catalogs.length, 64);
});
