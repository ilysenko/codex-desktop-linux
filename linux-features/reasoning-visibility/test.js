"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { descriptors } = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const { STORAGE_KEY, RUNTIME, reasoningVisibilitySnapshot } = require("./runtime.js");
const { MESSAGE_IDS, translations, settingsContract, settingComponent, applySettingsPatch } = require("./settings.js");

const standaloneSource = 'function classify(e,{includeGeneratedImages:n=!1}={}){switch(e.type){case`exec`:return wrap(e,`groupable`);case`generated-image`:return n?wrap(e,`standalone`):null;case`worktree-init`:return wrap(e,`standalone`);case`reasoning`:case`automation-update`:return null}}function wrap(e,t){return{item:e,grouping:t}}';
const persistentSource = 'function persistent({unit:e,hasFollowingFinalAnswer:t}){if(e.kind!==`standalone`)return!1;let a=e.item.item;return a.type===`user-input-response`?!a.completed:a.type===`assistant-message`&&a.important?!0:a.type===`user-message`&&!t}const partition={collapsibleUnits:[],persistentUnits:[]};';
const transcriptSource = 'function transcript(items,n){let i=[],a=[],s=()=>{a.length&&(i.push({type:`agent-activity`,items:a,collapseWhenPossible:!0}),a=[])};for(let o of items){let l=o.type===`reasoning`?null:{grouping:o.grouping};l?.grouping===`standalone`||n?.has(o)===!0?(s(),i.push({type:`activity-item`,key:`transcript-activity-item-${o.id}`,item:o})):a.push(o)}s();return i}';
const summariesSource = 'function options(client,mode){return{reasoningSummaryOverride:client.getDefaultFeatureOverride(`concurrent_reasoning_summaries`)===!0||mode?`detailed`:null,getRequestModel:e=>e,getRequestCollaborationMode(e){return e}}}function resolve(options,config,turn){let summary=`none`;options.reasoningSummaryOverride!=null&&(summary=options.reasoningSummaryOverride);summary=config.model_reasoning_summary??summary;turn.summary!==void 0&&(summary=turn.summary);return summary}';
const expandedSource = 'function reasoning(e){let{item:n}=e,l=!n.completed,f=n.content,[h,g]=(0,React.useState)(!1),_=!l&&!!f,v=n.content;let y=v,b=l?!!y:h,x=l?y:f,disclosure={expanded:h,onToggle:()=>{g(toggle)}},scroll={items:[{key:`reasoning-markdown`,node:x}],autoScrollToBottom:l,viewState:`expanded`};return{visible:b,disclosure,scroll}}function toggle(e){return!e}';
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
  for (const type of ["exec", "generated-image", "automation-update", "worktree-init"]) {
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
  const corrupted = patched(2).replace('o.type===`reasoning`||/*community-reasoning-visibility-transcript*/',
    'other.type===`reasoning`||/*community-reasoning-visibility-transcript*/');
  const result = warnings(() => descriptors[2].apply(corrupted));
  assert.equal(result.value, corrupted);
  assert.equal(result.messages.length, 1);
});

test("semantic asset selection accepts renamed chunks and refuses ambiguous files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-assets-"));
  try {
    const assets = path.join(root, "webview/assets");
    fs.mkdirSync(assets, { recursive: true });
    for (const [index, descriptor] of descriptors.slice(0, 5).entries()) {
      fs.writeFileSync(path.join(assets, "renamed-chunk.js"), sources[index]);
      const apply = () => patchUniqueAssetFile(root, descriptor.pattern, descriptor.assetMatch, descriptor.apply, "missing", "ambiguous");
      assert.equal(apply().changed, 1);
      assert.equal(apply().changed, 0);
      fs.writeFileSync(path.join(assets, "duplicate.js"), sources[index]);
      assert.equal(warnings(apply).value.changed, 0);
      fs.rmSync(path.join(assets, "duplicate.js"));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

function settingsFixture() {
  return 'function menu(e){let i=intlHook(),{platform:p}=platformHook(),v=useSetting(keys.macMenuBarEnabled);if(p!==`macOS`)return null;let label=i.formatMessage({id:`settings.general.macMenuBar.ariaLabel`});let c=(0,j.jsx)(Toggle,{checked:v,onChange:change,ariaLabel:label});return(0,j.jsx)(Row,{label:title,description:description,control:c})}' +
    'function another(){let[e,t]=(0,React.useState)(!1)}var React=reactFactory();' +
    'var page=(0,j.jsx)(menu,{appName:appName});/*settings.general.macMenuBar.description*/';
}

function catalogFixture() {
  return 'var messages={"settings.general.macMenuBar.label":"Existing","unrelated":"Unchanged"};export{messages as default};';
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
    localStorage, reactFactory: () => React, platformHook: () => ({ platform }),
    intlHook: () => ({ formatMessage: ({ id, defaultMessage }) => translations[locale]?.[MESSAGE_IDS.indexOf(id)] ?? defaultMessage }),
    Row: "row", Toggle: "toggle", j: { jsx: (type, props) => ({ type, props }) },
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
  const assets = path.join(root, "webview/assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "renamed-settings.js"), settingsFixture());
  for (const locale of locales) fs.writeFileSync(path.join(assets, `${locale}-current.js`), catalogFixture());
  return { root, assets };
}

test("native row and all 64 locale catalogs patch idempotently while existing messages stay unchanged", async (t) => {
  const locales = Object.keys(translations).filter((locale) => locale !== "en");
  const { root, assets } = settingsTree(t, locales);
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  assert.deepEqual(applySettingsPatch(root), { changed: false });
  for (const locale of locales) {
    const source = fs.readFileSync(path.join(assets, `${locale}-current.js`), "utf8");
    const { default: messages } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    assert.equal(messages.unrelated, "Unchanged");
    assert.equal(messages["settings.general.macMenuBar.label"], "Existing");
    assert.equal(Object.keys(messages).length, 5);
    for (const [index, id] of MESSAGE_IDS.entries()) assert.equal(messages[id], translations[locale][index], locale);
  }
});

test("missing translations or a partial catalog fail before writing settings or any catalog", (t) => {
  const { root, assets } = settingsTree(t);
  const settingsPath = path.join(assets, "renamed-settings.js"), originalSettings = fs.readFileSync(settingsPath, "utf8");
  const catalogPath = path.join(assets, "pl-PL-current.js"), originalCatalog = fs.readFileSync(catalogPath, "utf8");
  fs.writeFileSync(path.join(assets, "zz-current.js"), catalogFixture());
  assert.throws(() => applySettingsPatch(root), /missing translations for zz/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), originalCatalog);
  fs.rmSync(path.join(assets, "zz-current.js"));
  const partial = catalogFixture().replace('{"settings.general', '{"settings.general.reasoningVisibility.label":"Partial","settings.general');
  fs.writeFileSync(catalogPath, partial);
  assert.throws(() => applySettingsPatch(root), /incomplete or inconsistent/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings);
  assert.equal(fs.readFileSync(catalogPath, "utf8"), partial);
});

test("settings contract drift and duplicate assets fail closed", (t) => {
  const { root, assets } = settingsTree(t);
  const target = path.join(assets, "renamed-settings.js");
  fs.writeFileSync(target, settingsFixture().replace("onChange:change", "onChange:()=>change()"));
  assert.throws(() => applySettingsPatch(root), /native General setting contract/);
  assert.equal(fs.readFileSync(path.join(assets, "pl-PL-current.js"), "utf8"), catalogFixture());
  fs.writeFileSync(target, settingsFixture());
  fs.writeFileSync(path.join(assets, "duplicate.js"), settingsFixture());
  assert.throws(() => applySettingsPatch(root), /asset missing or ambiguous/);
});

test("General setting and catalogs compose idempotently with the optional tray settings", (t) => {
  const { root, assets } = settingsTree(t);
  fs.writeFileSync(path.join(assets, "request.js"),
    'async function post(...e){let[t,n]=e,{params:r,select:i,signal:a,source:o,responsePriority:s}=n??{};return raw(t,r,i,a,o,s)}async function raw(e){return client.post(`vscode://codex/${e}`)}export{post as fetchRequest};');
  const tray = require("../start-minimized-to-tray/patch.js").applySettingsPatch;
  assert.deepEqual(tray(root), { changed: true });
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  assert.deepEqual(tray(root), { changed: false });
  assert.deepEqual(applySettingsPatch(root), { changed: false });
});
