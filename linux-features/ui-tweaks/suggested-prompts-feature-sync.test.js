"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const {
  FEATURE_SYNC_MARKER, suggestedPromptsFeatureSyncContract: state,
  applySuggestedPromptsFeatureSyncPatch: apply,
} = require("./patches/suggested-prompts-feature-sync.js");
const { descriptors } = require("./patches/suggested-prompts.js");
const { applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const selected = descriptors.filter(d => d.id === "home-suggested-prompts-feature-sync");
const context = { feature: { settings: { tweaks: { home: { suggestedPrompts: { enabled: true } } } } } };
const gate = 'rollout=(0,Gate.enabled)("2425897452")';
const body = 'var Gate=load("gates"),React=load("react"),Dispatch=load("bus"),State=load("state"),' +
  'Availability=load("availability"),View=load("jsx");' +
  `function SyncComponent(){let ${gate},runtimeStatus=(0,State.read)(Availability.current);` +
  'return(0,React.useEffect)(()=>{Dispatch.bus.dispatchMessage("electron-desktop-features-changed",' +
  '{ambientSuggestions:rollout&&"enabled"===runtimeStatus.status,unrelated:17})},[rollout,runtimeStatus.status]),null}' +
  'function Mount(){return(0,View.jsx)(SyncComponent,{})}load.d(exports,{render:()=>Mount});';
const chunk = (body, id = "Sync") => `export const __webpack_modules__={${id}(module,exports,load){${body}}};`;
const fixture = chunk(body);

function render(source, status) {
  const effects = [], diagnostics = [], sent = [], exports = {};
  const imports = {
    gates: { enabled: key => { diagnostics.push(key); return false; } },
    react: { useEffect: callback => effects.push(callback) },
    bus: { bus: { dispatchMessage: (type, value) => sent.push({ type, value }) } },
    state: { read: () => ({ status }) }, availability: { current: "host-status" },
    jsx: { jsx: component => component },
  };
  const load = id => { assert.ok(imports[id], id); return imports[id]; };
  load.d = (target, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get });
  };
  const factory = vm.runInNewContext(source.replace("export const __webpack_modules__=", "const modules=") + ";modules.Sync");
  factory({}, exports, load);
  exports.render()();
  effects.forEach(callback => callback());
  return { diagnostics, sent };
}

test("feature sync reuses its mounted component's gate/status bindings and calls the native gate for diagnostics", () => {
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(state(patched), "patched");
  assert.equal(apply(patched), patched);
  const prefixed = `/* another feature */function ${FEATURE_SYNC_MARKER}Shadow(){}${patched}`;
  assert.equal(state(prefixed), "patched");
  assert.equal(apply(prefixed), prefixed);
  for (const status of ["enabled", "disabled", "loading"]) {
    const before = render(fixture, status), after = render(patched, status);
    assert.deepEqual(after.diagnostics, before.diagnostics);
    assert.deepEqual(after.diagnostics, ["2425897452"]);
    assert.equal(after.sent.length, 1);
    assert.equal(after.sent[0].type, "electron-desktop-features-changed");
    assert.equal(after.sent[0].value.ambientSuggestions, status === "enabled");
    assert.equal(after.sent[0].value.unrelated, before.sent[0].value.unrelated);
  }
});

test("feature sync rejects a same-spelled gate moved into a different or nested lexical owner", t => {
  t.mock.method(console, "warn", () => {});
  const withoutGate = body.replace(gate, "rollout=!1");
  for (const source of [
    chunk(withoutGate) + `function unused(){let ${gate};return rollout}`,
    chunk(withoutGate + `function unused(){let ${gate};return rollout}`),
    chunk(body.replace(gate, `unused=()=>{let ${gate};return rollout},rollout=!1`)),
    fixture.replace('()=>{Dispatch.bus', 'rollout=>{Dispatch.bus'),
    fixture.replace('()=>{Dispatch.bus', 'runtimeStatus=>{Dispatch.bus'),
    fixture.replace('()=>{Dispatch.bus', '()=>{let rollout=false;Dispatch.bus'),
    fixture.replace('let rollout=', 'let Gate={enabled:()=>false},rollout='),
    fixture.replace('State.read)(Availability.current)', 'State.read)(unknown.current)'),
    fixture.replace('Gate=load("gates")', 'Gate=wrongLoader("gates")'),
    fixture.replace('function SyncComponent(){', 'const unused=function SyncComponent(){')
      .replace('}function Mount()', '};function Mount()'),
  ]) {
    assert.equal(javascriptSourceParses(source), true);
    const rejected = captureWarnings(() => apply(source));
    assert.equal(state(source), "drifted");
    assert.equal(rejected.value, source);
    assert.equal(rejected.warnings.length, 1);
  }
});

test("complete feature sync proof rejects changed consumer, dependencies, owner, helper and extra assignments", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture);
  for (const source of [
    patched.replace('ambientSuggestions:rollout&&', 'ambientSuggestions:wrongRollout&&'),
    patched.replace('runtimeStatus.status,unrelated', 'wrongStatus.status,unrelated'),
    patched.replace('[rollout,runtimeStatus.status]', '[wrongRollout,runtimeStatus.status]'),
    patched.replace('[rollout,runtimeStatus.status]', '[rollout,runtimeStatus.state]'),
    patched.replace('jsx)(SyncComponent,{})', 'jsx)(OtherComponent,{})'),
    patched.replace('function SyncComponent(){', 'function OtherComponent(){'),
    patched.replace('function Mount(){', 'function Mount(View){'),
    patched.replace('function Mount(){', 'function Mount(){let View={jsx:()=>null};'),
    patched.replace('()=>{Dispatch.bus', 'rollout=>{Dispatch.bus'),
    patched.replace('()=>{Dispatch.bus', '()=>{let rollout=false;Dispatch.bus'),
    patched.replace(';return(0,React.useEffect)', ';rollout=false;return(0,React.useEffect)'),
    patched.replace(`function ${FEATURE_SYNC_MARKER}(){return!0}`, `function ${FEATURE_SYNC_MARKER}(){return!1}`),
    patched.replace(`function ${FEATURE_SYNC_MARKER}(){return!0}()`, `true/*${FEATURE_SYNC_MARKER}*/`),
    patched + `function ${FEATURE_SYNC_MARKER}(){return!0}`,
  ]) {
    assert.notEqual(source, patched);
    assert.equal(javascriptSourceParses(source), true);
    const rejected = captureWarnings(() => apply(source));
    assert.equal(state(source), "drifted");
    assert.equal(rejected.value, source);
    assert.equal(rejected.warnings.length, 1);
  }
});

function workspace(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "suggested-prompts-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets");
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(assets, name)), { recursive: true });
    fs.writeFileSync(path.join(assets, name), source);
  }
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, normalizePatchDescriptors(selected), context, report, selected[0].phase);
    return report.patches[0];
  };
  return { root, run, read: name => fs.readFileSync(path.join(assets, name), "utf8") };
}

test("feature sync normal descriptor validates all same-ID copies and becomes idempotent", t => {
  const renamed = fixture.replaceAll("rollout", "$localGate").replaceAll("runtimeStatus", "$localStatus");
  const app = workspace(t, { "async/one.js": fixture, "nested/two.js": renamed });
  assert.equal(selected[0].phase, "extracted-app:pre-webview");
  assert.equal(app.run().status, "applied");
  assert.equal(app.read("async/one.js"), apply(fixture));
  assert.equal(app.read("nested/two.js"), apply(renamed));
  assert.equal(app.run().status, "already-applied");
});

test("feature sync normal descriptor preserves missing, damaged, mixed and different-identity copies", t => {
  t.mock.method(console, "warn", () => {});
  for (const second of [
    chunk("const missingGate=true;"),
    fixture.replace('rollout=(0,Gate.enabled)("2425897452")', 'rollout=false'),
    chunk(body.replace(gate, "rollout=false")) + `function unused(){let ${gate};return rollout}`,
    chunk(body.replace(gate, `unused=()=>{let ${gate};return rollout},rollout=false`)),
    apply(fixture),
    chunk(body, "DifferentIdentity"),
    apply(fixture).replace('ambientSuggestions:rollout&&', 'ambientSuggestions:wrong&&'),
    fixture + `function ${FEATURE_SYNC_MARKER}(){return!0}`,
  ]) {
    const app = workspace(t, { "async/one.js": fixture, "nested/two.js": second });
    assert.equal(app.run().status, "skipped-optional");
    assert.equal(app.read("async/one.js"), fixture);
    assert.equal(app.read("nested/two.js"), second);
  }
});

test("feature sync production transaction restores both original copies after a later write fails", t => {
  t.mock.method(console, "warn", () => {});
  const app = workspace(t, { "async/one.js": fixture, "nested/two.js": fixture });
  const write = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, "writeFileSync", (file, bytes) => {
    write(file, bytes);
    if (++writes === 2) throw Error("interrupted feature sync write");
  });
  assert.equal(app.run().status, "skipped-optional");
  assert.equal(app.read("async/one.js"), fixture);
  assert.equal(app.read("nested/two.js"), fixture);
});

function nativeComponent(moduleSource) {
  const index = moduleSource.indexOf('("2425897452")');
  const owners = [...moduleSource.matchAll(/function ([\w$]+)\(\)\{/g)].map(header => {
    const end = findMatchingBrace(moduleSource, header.index + header[0].length - 1);
    return { name: header[1], start: header.index, end };
  }).filter(owner => owner.start < index && index < owner.end);
  assert.equal(owners.length, 1);
  const owner = owners[0];
  return { name: owner.name, source: moduleSource.slice(owner.start, owner.end + 1) };
}

// Execute the actual mounted native component, not the entire application
// factory. Imports are inert hooks/transport stubs, and effects run only after
// render, so diagnostics, host arguments and the final native payload are real
// component behavior without app initialization or user/model requests.
function renderNative(moduleSource, status, hostId) {
  const component = nativeComponent(moduleSource);
  const gateCall = /\(0,([\w$]+)\.([\w$]+)\)\("2425897452"\)/.exec(component.source);
  const consumer = /ambientSuggestions:[\w$]+&&"enabled"===([\w$]+)\.status/.exec(component.source);
  const statusRead = new RegExp(`${escapeRegExp(consumer[1])}=\\(0,([\\w$]+)\\.[\\w$]+\\)\\(([\\w$]+)\\.([\\w$]+)\\)`).exec(component.source);
  const hostVariable = /\{hostId:([\w$]+)\}/.exec(component.source)[1];
  const hostRead = new RegExp(`${escapeRegExp(hostVariable)}=\\(0,[\\w$]+\\.[\\w$]+\\)\\(([\\w$]+)\\.([\\w$]+)\\)`).exec(component.source);
  const statusKeys = new Set([...component.source.matchAll(/([\w$]+)\.status/g)].flatMap(match => {
    const read = new RegExp(`${escapeRegExp(match[1])}=\\(0,[\\w$]+\\.[\\w$]+\\)\\(([\\w$]+)\\.([\\w$]+)\\)`).exec(component.source);
    return read == null ? [] : [`${read[1]}.${read[2]}`];
  }));
  const react = /\(0,([\w$]+)\.useEffect\)/.exec(component.source)[1];
  const effects = [], diagnostics = [], hosts = [], sent = [];
  const ready = { available: false, allowed: false, isLoading: false, isSuccess: true,
    reason: "disabled", data: [], get: () => false };
  const value = tag => new Proxy(function (...args) {
    if (args[0] != null && typeof args[0] === "object" && Object.hasOwn(args[0], "hostId")) hosts.push(args[0].hostId);
    return ready;
  }, { get(_target, key) {
    if (key === "tag") return tag;
    if (key === "appServices") return {};
    if (key === "dispatchMessage") return (type, payload) => sent.push({ type, payload });
    if (key === "safeParse") return () => ({ success: false });
    return value(`${tag}.${String(key)}`);
  } });
  const globals = Object.fromEntries([...component.source.matchAll(/(?<![\w$.])([\w$]+)\./g)]
    .map(match => [match[1], value(match[1])]));
  for (const match of component.source.matchAll(/\.Ul\)\(([\w$]+)\)/g)) globals[match[1]] ??= value(match[1]);
  const snapshot = /\.useSyncExternalStore\)\([^,]+,([\w$]+),/.exec(component.source);
  assert.ok(snapshot);
  globals[snapshot[1]] = () => false;
  globals[react] = { useEffect: callback => effects.push(callback), useSyncExternalStore: () => false };
  globals[gateCall[1]] = new Proxy({}, { get(_target, key) {
    if (key === gateCall[2]) return id => { diagnostics.push(typeof id === "function" ? id.tag : id); return false; };
    if (key === "XR") return () => false;
    if (key === "cn") return () => ({ client: { getContext: () => ({ user: { custom: {}, customIDs: {} } }) } });
    if (key === "Fj") return () => ({ value: {} });
    return value(`${gateCall[1]}.${String(key)}`);
  } });
  globals[statusRead[1]] = {
    gh: () => ({ set() {} }),
    Ul: token => token.tag === `${statusRead[2]}.${statusRead[3]}` ? { status }
      : token.tag === `${hostRead[1]}.${hostRead[2]}` ? hostId
        : statusKeys.has(token.tag) ? { status: "allowed" } : false,
    _U: () => ready,
  };
  vm.runInNewContext(`${component.source};${component.name}()`, globals,
    { filename: "native-feature-sync-component.js", displayErrors: false });
  effects.forEach(callback => callback());
  const published = sent.filter(event => event.type === "electron-desktop-features-changed");
  assert.equal(published.length, 1);
  return { diagnostics, hosts, payload: published[0].payload };
}

test("feature sync current signed copies patch through the normal descriptor without changing the retained input", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  t.mock.method(console, "warn", () => {});
  const original = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
  const copies = findUniqueRspackModuleCopies(original, {
    sourceMatch: source => source.includes('dispatchMessage("electron-desktop-features-changed"'),
    matchModule: source => source.includes('dispatchMessage("electron-desktop-features-changed"'),
  });
  const files = Object.fromEntries(copies.map(copy => [copy.assetName, copy.source]));
  const app = workspace(t, files);
  const patchedCopies = new Map();
  assert.equal(app.run().status, "applied");
  for (const copy of copies) {
    const patched = app.read(copy.assetName);
    patchedCopies.set(copy.assetName, patched);
    assert.notEqual(patched, copy.source);
    assert.equal(javascriptSourceParses(patched), true);
    assert.equal(state(patched), "patched");
    assert.equal(fs.readFileSync(path.join(original, copy.assetName), "utf8"), copy.source);
    const patchedModule = [...rspackModuleFactories(patched, copy.assetName)]
      .find(module => module.moduleId === copy.moduleId).moduleSource;
    for (const status of ["enabled", "disabled", "loading"]) for (const host of ["local", "ssh-remote"]) {
      const before = renderNative(copy.moduleSource, status, host), after = renderNative(patchedModule, status, host);
      assert.deepEqual(after.diagnostics, before.diagnostics);
      assert.equal(after.diagnostics.filter(key => key === "2425897452").length, 1);
      assert.ok(after.hosts.length > 0);
      assert.ok(after.hosts.every(value => value === host));
      assert.deepEqual(after.hosts, before.hosts);
      assert.equal(after.payload.ambientSuggestions, status === "enabled");
      assert.equal(JSON.stringify({ ...after.payload, ambientSuggestions: null }),
        JSON.stringify({ ...before.payload, ambientSuggestions: null }));
    }
  }
  assert.equal(app.run().status, "already-applied");
  const owner = copies[0], filename = path.join(app.root, "webview/assets", owner.assetName);
  const nativeGate = /(?<![\w$.])([\w$]+)=(\(0,[\w$]+\.[\w$]+\)\("2425897452"\))/.exec(owner.moduleSource);
  const patched = patchedCopies.get(owner.assetName);
  const component = nativeComponent([...rspackModuleFactories(patched, owner.assetName)]
    .find(module => module.moduleId === owner.moduleId).moduleSource);
  for (const [applied, damaged] of [
    [false, owner.source.replace(nativeGate[0], `${nativeGate[1]}=false`) +
      `function unusedGate(){let ${nativeGate[0]};return ${nativeGate[1]}}`],
    [true, patched.replace(`ambientSuggestions:${nativeGate[1]}&&`, 'ambientSuggestions:wrongRollout&&')],
    [true, patched.replace(`function ${component.name}(){`, 'function codexAuditWrongOwner(){')],
  ]) {
    assert.equal(javascriptSourceParses(damaged), true);
    for (const copy of copies) fs.writeFileSync(path.join(app.root, "webview/assets", copy.assetName),
      applied ? patchedCopies.get(copy.assetName) : copy.source);
    fs.writeFileSync(filename, damaged);
    assert.equal(app.run().status, "skipped-optional");
    for (const copy of copies) assert.equal(app.read(copy.assetName), copy === owner ? damaged
      : applied ? patchedCopies.get(copy.assetName) : copy.source);
  }
});
