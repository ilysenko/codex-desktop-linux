"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { graphBody, fixture } = require("../../scripts/patches/lib/fixtures/main-request-graph.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { MARKER, entryFactories, inspectRecordReplayPluginGate: inspect } = require("./plugin-gate.js");

const OWNER = "early-bootstrap-45-abc.js";
const ROLES = ["codexAppTools", "browser", "unifiedComputerUse", "chromeDev", "chromeInternal", "chrome", "computerUse", "messages",
  "recordAndReplay", "computerHistory", "latex", "notebook", "plan", "deepResearch", "visualize"];
const INSTALL_SELECTION = 't.marketplacePluginDescriptors.filter(e=>!0===e.installWhenMissing).filter(r=>{if(null==r.autoInstallOptOutKey)return!0;let n=e.globalState.get(r.autoInstallOptOutKey);return!0!==r.installWhenMissingRequiresOptIn||r.name===rS.t_&&t.desktopFeatureAvailability.computerUseAutoInstall?!0!==n:!1===n}).map(e=>e.name)';

function seedEntry(namespaceBody = 'n.d(t,{iRL:()=>eK.iR});var eK=n(84766);', definitionsBody) {
  const definitions = definitionsBody ?? 'let x={recordAndReplay:{name:"record-and-replay"}};n.d(t,{},{iR:x});';
  const table = `1(e,t,n){n.e(45).then(n.bind(n,82820))},40614(e,t,n){${namespaceBody}},84766(e,t,n){${definitions}}`;
  return `(()=>{var e,t,n,a={${table}},i={};function r(e){var t=i[e];if(void 0!==t)return t.exports;var n=i[e]={exports:{}};return a[e].call(n.exports,n,n.exports,r),n.exports}r.m=a,r.c=i,r.f={},r.u=e=>"early-bootstrap-"+e+"-abc.js",r.o=(e,t)=>Object.prototype.hasOwnProperty.call(e,t),n={942:1},r.f.require=(e,t)=>{n[e]||(e=>{var t=e.modules,a=e.ids,i=e.runtime;for(var o in t)r.o(t,o)&&(r.m[o]=t[o]);i&&i(r);for(var s=0;s<a.length;s++)n[a[s]]=1})(require("./"+r.u(e)))};var o=r(1);module.exports=o})();`;
}
function filesFixture() {
  const rows = ROLES.map(role => role === "recordAndReplay"
    ? '{...ei.iRL.recordAndReplay,isAvailable:({features:e,platform:t})=>"darwin"===t&&e.recordAndReplay}'
    : role === "computerUse"
      ? '{...ei.iRL.computerUse,autoInstallOptOutKey:(0,ei.kTr)(ei.iRL.computerUse.name),isAvailable:({features:e,platform:t})=>("darwin"===t||"win32"===t)&&e.computerUse}'
    : `{...ei.iRL.${role},isAvailable:()=>!0${role === "browser" ? ',migrate:()=>["nested",["array"]]' : ""}}`);
  const registry = `var ei=require(40614);let a5=[${rows.join(",")}];`;
  const controller = `let pluginController=function(e){let s=e.env,p=e.platform??process.platform,k=t=>a5.filter(r=>r.isAvailable({buildFlavor:e.buildFlavor,env:s,features:t,platform:p}));function reconcile(t){return ${INSTALL_SELECTION}}return{setDesktopFeatureAvailability:e=>k(e),waitForPendingReconcile:()=>reconcile}}({buildFlavor:"production",env:{},globalState:{get(){}}});`;
  const body = registry + graphBody().replace('function runMainAppStartup(e){', 'function runMainAppStartup(e){' + controller);
  const files = { "early-bootstrap.js": seedEntry(), [OWNER]: fixture(body) };
  for (let index = 0; index < 17; index++) files[`early-bootstrap-${100 + index}-ab${index.toString(16)}.js`] =
    `exports.ids=[${100 + index}],exports.modules={${5000 + index}(e,t,n){return ${index}}};`;
  return files;
}
function assets(files) { return Object.entries(files).map(([assetName, source]) => ({ assetName, source })); }
function extracted(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "record-replay-plugin-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".vite/build"), { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, ".vite/build", name), source);
  return root;
}
function run(root, enabled = ["record-and-replay"], architecture = "x64") {
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled, settings: {} }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config });
  const descriptors = normalizePatchDescriptors(loaded.filter(descriptor => descriptor.id === "feature:record-and-replay:record-and-replay-plugin-gate"));
  const report = createPatchReport(), warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { applyExtractedAppPatchDescriptors(root, descriptors, { linux: { arch: architecture } }, report, "extracted-app:pre-webview"); }
  finally { console.warn = warn; }
  return { patch: report.patches[0], warnings, descriptors };
}
function readFiles(root) {
  const dir = path.join(root, ".vite/build");
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
}
function assertUnchanged(root, files) { assert.deepEqual(readFiles(root), files); }
function stripCanonical(source, plan) {
  const at = plan.factory.start + plan.registry.record.start;
  return source.slice(0, at) + plan.registry.raw + source.slice(at + plan.registry.canonical.length);
}
function evaluateRow(plan, platform, imported = { name: "record-and-replay" }) {
  const [binding, field] = plan.registry.namespace.split(".");
  return vm.runInNewContext("(" + plan.registry.record.text + ")", {
    [binding]: { [field]: { recordAndReplay: imported } }, process: { platform },
  });
}
function controllerSelection(plan, row, platform, features, preference) {
  const control = { name: "computer-use", installWhenMissing: true, installWhenMissingRequiresOptIn: true,
    autoInstallOptOutKey: "cua-opt-out", isAvailable: () => true };
  const context = { [plan.registry.binding]: [row, control], [plan.controller.options]: { buildFlavor: "production", globalState: { get: () => preference } },
    [plan.controller.env]: {}, [plan.controller.platform]: platform };
  const eligible = vm.runInNewContext("(" + plan.controller.eligibility + ")", context)(features);
  const optIn = /\.name===([\w$]+)\.([\w$]+)&&/u.exec(plan.controller.installSelection);
  assert.ok(optIn);
  context[optIn[1]] = { [optIn[2]]: "computer-use" };
  context[plan.controller.installOptions] = { marketplacePluginDescriptors: eligible, desktopFeatureAvailability: { computerUseAutoInstall: false } };
  return { available: eligible.some(plugin => plugin.name === "record-and-replay"),
    installs: Array.from(vm.runInNewContext(plan.controller.installSelection, context)) };
}
function assertPolicy(raw, canonical) {
  for (const platform of ["linux", "darwin", "win32"]) for (const recordAndReplay of [false, true]) {
    const before = evaluateRow(raw, platform), after = evaluateRow(canonical, platform);
    assert.equal(after.isAvailable({ platform, features: { recordAndReplay } }), platform === "linux" || platform === "darwin" && recordAndReplay);
    const expected = platform === "linux" ? true : before.isAvailable({ platform, features: { recordAndReplay } });
    assert.equal(after.isAvailable({ platform, features: { recordAndReplay } }), expected);
    const beforeSelected = controllerSelection(raw, before, platform, { recordAndReplay }, undefined);
    const selected = controllerSelection(canonical, after, platform, { recordAndReplay }, undefined);
    assert.equal(selected.available, expected);
    assert.equal(selected.installs.includes("record-and-replay"), platform === "linux");
    assert.equal(selected.installs.includes("computer-use"), false);
    if (platform !== "linux") assert.deepEqual(selected, beforeSelected);
    assert.equal(controllerSelection(canonical, after, platform, { recordAndReplay }, false).installs.includes("computer-use"), true);
    for (const installWhenMissing of [undefined, false, true]) {
      const imported = { name: "record-and-replay", installWhenMissing, hidden: true, nativeMetadata: { retained: true } };
      const original = evaluateRow(raw, platform, imported), patched = evaluateRow(canonical, platform, imported);
      assert.equal(patched.installWhenMissing, platform === "linux" ? true : original.installWhenMissing);
      assert.equal(patched.hidden, original.hidden);
      assert.deepEqual(patched.nativeMetadata, original.nativeMetadata);
    }
  }
}

test("Record & Replay plugin gate qualifies the existing row and updates only its Linux policy", t => {
  const files = filesFixture(), raw = inspect(assets(files));
  assert.equal(raw.state, "current", raw.reason); assert.equal(raw.registry.rows.length, 15);
  const root = extracted(t, files), first = run(root);
  assert.equal(first.patch.status, "applied"); assert.equal(first.descriptors[0].phase, "extracted-app:pre-webview");
  assert.equal(first.descriptors[0].order, 150);
  const patchedFiles = readFiles(root), canonical = inspect(assets(patchedFiles));
  assert.equal(canonical.state, "patched", canonical.reason);
  assert.equal(stripCanonical(patchedFiles[OWNER], canonical), files[OWNER]);
  assert.deepEqual(Object.keys(files).filter(name => files[name] !== patchedFiles[name]), [OWNER]);
  assert.deepEqual(canonical.registry.rows.filter(row => !row.text.includes(MARKER)).map(row => row.text), raw.registry.rows.filter(row => !row.text.includes(".recordAndReplay,")).map(row => row.text));
  assert.equal(run(root).patch.status, "already-applied"); assert.deepEqual(readFiles(root), patchedFiles);
  assertPolicy(raw, canonical);
  assert.equal(run(root, []).patch, undefined); assert.deepEqual(readFiles(root), patchedFiles);
});

test("Record & Replay plugin gate accepts native main helper prefixes without changing them", t => {
  const files = filesFixture(); files[OWNER] = 'function codexNativeMainHelper(){return null}\n' + files[OWNER];
  files["early-bootstrap.js"] = 'function codexNativeEntryHelper(){return null}\n' + files["early-bootstrap.js"];
  const root = extracted(t, files); assert.equal(run(root).patch.status, "applied");
  const output = readFiles(root), plan = inspect(assets(output)); assert.equal(plan.state, "patched", plan.reason);
  assert.equal(stripCanonical(output[OWNER], plan), files[OWNER]);
});

test("Record & Replay plugin gate composes with the committed Computer Use gate", t => {
  const { applyLinuxComputerUsePluginGatePatch } = require("../computer-use-linux/plugin-gate.js");
  const files = filesFixture(); files[OWNER] = applyLinuxComputerUsePluginGatePatch(files[OWNER]);
  const root = extracted(t, files); assert.equal(run(root).patch.status, "applied");
  const output = readFiles(root), plan = inspect(assets(output)); assert.equal(plan.state, "patched", plan.reason);
  assert.equal(stripCanonical(output[OWNER], plan), files[OWNER]);
  assert.match(output[OWNER], /"win32"===t\|\|"linux"===t\)&&e\.computerUse/u);
  assert.equal(run(root).patch.status, "already-applied");
});

test("Record & Replay gate refuses complete cross-carrier bad cohorts after a warm owner cache", t => {
  const base = filesFixture(), root = extracted(t, base); assert.equal(run(root).patch.status, "applied");
  const canonical = readFiles(root);
  const variants = {
    duplicateOwner: files => { files["early-bootstrap-100-ab0.js"] = files[OWNER]; },
    mixedOwner: files => { files["early-bootstrap-100-ab0.js"] = canonical[OWNER]; },
    hiddenOwner: files => { files["early-bootstrap-100-ab0.js"] = 'exports.ids=[100],exports.modules={8.282e4(){return false}};'; },
    hiddenNamespace: files => { files["early-bootstrap-100-ab0.js"] = 'exports.ids=[100],exports.modules={"40614"(){return false}};'; },
    hiddenDefinitions: files => { files["early-bootstrap-100-ab0.js"] = 'exports.ids=[100],exports.modules={84766(){return false}};'; },
    changedNamespaceOnly: files => { files["early-bootstrap.js"] = files["early-bootstrap.js"].replace('iRL:()=>eK.iR', 'iRL:()=>eK.iR()'); },
    changedDefinitionsOnly: files => { files["early-bootstrap.js"] = files["early-bootstrap.js"].replace('name:"record-and-replay"', 'name:"foreign-plugin"'); },
    namespaceWrite: files => { files["early-bootstrap.js"] = files["early-bootstrap.js"].replace('var eK=n(84766);', 'var eK=n(84766);eK.iR=other;'); },
    definitionDuplicate: files => { files["early-bootstrap.js"] = files["early-bootstrap.js"].replace('recordAndReplay:{name:"record-and-replay"}', 'recordAndReplay:{name:"record-and-replay"},recordAndReplay:{name:"foreign"}'); },
    orphanMarker: files => { files["early-bootstrap-100-ab0.js"] += JSON.stringify(MARKER) + ';'; },
    partialCanonical: files => { files[OWNER] = canonical[OWNER].replace(MARKER, ''); },
    duplicateExistingRow: files => { const plan = inspect(assets(files)); files[OWNER] = files[OWNER].replace(plan.registry.raw, plan.registry.raw + ',' + plan.registry.raw); },
    extraLiteralPlugin: files => { files[OWNER] += ';const plugin={name:"record-and-replay"};'; },
    registryMutation: files => { files[OWNER] = files[OWNER].replace('function runMainAppStartup(e){', 'a5.push(other);function runMainAppStartup(e){'); },
    processShadow: files => { files[OWNER] = files[OWNER].replace('var ei=', 'var process={platform:"darwin"};var ei='); },
    controllerDetached: files => { files[OWNER] = files[OWNER].replace('let pluginController=function(e)', 'let pluginController=unrelated;function unused(e)'); },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    for (const [assetName, source] of Object.entries(base)) fs.writeFileSync(path.join(root, ".vite/build", assetName), source);
    assert.equal(run(root).patch.status, "applied", "warm " + name);
    for (const [assetName, source] of Object.entries(base)) fs.writeFileSync(path.join(root, ".vite/build", assetName), source);
    const changed = { ...base }; mutate(changed);
    for (const [assetName, source] of Object.entries(changed)) fs.writeFileSync(path.join(root, ".vite/build", assetName), source);
    const result = run(root); assert.equal(result.patch.status, "skipped-optional", name); assert.ok(result.warnings.length, name);
    assertUnchanged(root, changed);
  }
});

test("Record & Replay entry extraction requires the evaluated native loader and caller", () => {
  const original = seedEntry(); assert.equal(entryFactories(original).length, 3);
  for (const source of [
    'false&&' + original,
    original.replace('return a[e].call', 'return other[e].call'),
    original.replace('r.m=a,r.c=i', 'r.m=other,r.c=i'),
    original.replace(';var o=r(1);', ';if(false)var o=r(1);'),
    original.replace(';var o=r(1);', ';return;var o=r(1);'),
    original.replace('r.m[o]=t[o]', 'other[o]=t[o]'),
    original.replace(';var o=r(1);', ';r.m=other;var o=r(1);'),
    original.replace(';var o=r(1);', ';r=other;var o=r(1);'),
    original.replace('module.exports=o', 'module.exports=other'),
    'var require=other;' + original,
    original.replace(';var o=r(1);', ';module=other;var o=r(1);'),
    original.replace('n={942:1},r.f.require=', 'false&&(n={942:1}),r.f.require='),
    original.replace(',r.f.require=', ',false&&(r.f.require=').replace('};var o=r(1);', '});var o=r(1);'),
  ]) assert.throws(() => entryFactories(source));
});

test("Record & Replay authority rejects conditional native declaration carriers", t => {
  const original = filesFixture();
  const variants = [
    [OWNER, 'let a5=[', 'if(false)var a5=['],
    [OWNER, 'var ei=require(40614);', 'if(false)var ei=require(40614);'],
    [OWNER, 'let pluginController=function(e)', 'if(false)var pluginController=function(e)'],
    ['early-bootstrap.js', 'var eK=n(84766);', 'if(false)var eK=n(84766);'],
    ['early-bootstrap.js', 'let x={', 'if(false)var x={'],
    ['early-bootstrap.js', 'var eK=n(84766);', 'return;var eK=n(84766);'],
  ];
  for (const [name, from, to] of variants) {
    const files = { ...original, [name]: original[name].replace(from, to) };
    assert.notEqual(files[name], original[name]); new vm.Script(files[name]);
    const root = extracted(t, files), result = run(root);
    assert.equal(result.patch.status, "skipped-optional", to); assertUnchanged(root, files);
  }
});

test("Record & Replay protected imports distinguish ordinary block writes and local shadows", t => {
  const original = filesFixture(), root = extracted(t, original);
  assert.equal(run(root).patch.status, "applied");
  const canonical = readFiles(root), entry = canonical['early-bootstrap.js'];
  const replaceEntry = suffix => entry.replace('var eK=n(84766);', 'var eK=n(84766);' + suffix);
  const rejected = [
    ';{eK={iR:{recordAndReplay:{name:"not-the-native-record-plugin"}}};}',
    ';{eK++;}',
    ';{({value:eK}=other);}',
    String.raw`;{e\u004b=other;}`,
    String.raw`;{e\u{4b}=other;}`,
    ';{var eK=other;}',
    ';{var {value:eK}=other;}',
    ';function local(other=(eK=other)){let eK;}',
    ';const local=(other=(eK=other))=>{let eK;};',
    ';class Local{#state;run(other=(eK=other)){let eK=this.#state}}',
    ';class Local{#state;run(){this.#state;eK=other}}',
    ';if(eK){eK=other;}',
    ';while(eK){eK=other;break;}',
  ];
  for (const suffix of rejected) {
    fs.writeFileSync(path.join(root, '.vite/build/early-bootstrap.js'), entry);
    assert.equal(run(root).patch.status, "already-applied", "warm " + suffix);
    const changed = { ...canonical, 'early-bootstrap.js': replaceEntry(suffix) };
    assert.equal(changed[OWNER], canonical[OWNER]); new vm.Script(changed['early-bootstrap.js']);
    fs.writeFileSync(path.join(root, '.vite/build/early-bootstrap.js'), changed['early-bootstrap.js']);
    assert.equal(run(root).patch.status, "skipped-optional", suffix); assertUnchanged(root, changed);
  }
  for (const suffix of [
    ';{let eK=other;eK=next;}',
    ';{const eK={};}',
    ';{class eK{}}',
    ';function local(eK){eK=other}',
    ';function local(){if(flag){var eK=other}}',
    ';function local(eK=Date.now()){eK=other}',
    ';const local=eK=>eK=other;',
    ';const local=(eK=Date.now())=>{eK=other};',
    ';const local=function eK(){eK=other};',
    ';class Local{#state;run(eK=this.#state){eK=other}}',
    ';class Local{#state;run(){var eK=this.#state;eK=other}}',
    ';class Local{eK=0;run(){return this.eK}}',
    ';class Local{if(eK){eK=other}}',
  ]) {
    const files = { ...original, 'early-bootstrap.js': original['early-bootstrap.js'].replace('var eK=n(84766);', 'var eK=n(84766);' + suffix) };
    new vm.Script(files['early-bootstrap.js']);
    const plan = inspect(assets(files)); assert.equal(plan.state, "current", suffix + " " + plan.reason);
  }
});

test("Record & Replay protects the table and native loader outside ordinary block shadows", () => {
  const original = filesFixture(), entry = original['early-bootstrap.js'];
  for (const [from, to] of [
    ['n.d(t,{},{iR:x});', 'n.d(t,{},{iR:x});{x=other;}'],
    [';var o=r(1);', ';{r=other;}var o=r(1);'],
    [';var o=r(1);', ';{a=other;}var o=r(1);'],
    [';var o=r(1);', ';{n=other;}var o=r(1);'],
  ]) {
    const files = { ...original, 'early-bootstrap.js': entry.replace(from, to) };
    new vm.Script(files['early-bootstrap.js']); assert.equal(inspect(assets(files)).state, "invalid", to);
  }
  for (const [from, to] of [
    ['n.d(t,{},{iR:x});', 'n.d(t,{},{iR:x});{let x=other;}'],
    [';var o=r(1);', ';{let r=other;}var o=r(1);'],
    [';var o=r(1);', ';function local(r){r=other}var o=r(1);'],
  ]) {
    const files = { ...original, 'early-bootstrap.js': entry.replace(from, to) };
    new vm.Script(files['early-bootstrap.js']); const plan = inspect(assets(files)); assert.equal(plan.state, "current", to + " " + plan.reason);
  }
});

test("Record & Replay qualified fields treat dotted and static computed spellings equally", () => {
  const original = filesFixture(), entry = original['early-bootstrap.js'];
  const keys = ['"iR"', "'iR'", '`iR`', String.raw`"\u0069R"`, String.raw`'\u0069R'`, String.raw`"\x69R"`,
    String.raw`'\x69R'`, String.raw`"\u{69}R"`, '`i' + String.raw`\u0052` + '`'];
  const namespaceWrites = [
    ';eK.iR=other;',
    String.raw`;eK.i\u0052=other;`,
    String.raw`;eK.i\u{52}=other;`,
    String.raw`;e\u004b["iR"]=other;`,
    ';eK /* receiver */ [ /* key */ "iR" /* close */ ]=other;',
    ';eK[lookup]=other;',
    ';eK["i"+"R"]=other;',
    ';eK[`i${suffix}`]=other;',
    ';function local(other=(eK["iR"]=other)){let eK;}',
    ';const extraRead=eK.iR;',
    ';const extraRead=eK["iR"];',
    ...keys.map(key => `;eK[${key}]=other;`),
  ];
  for (const suffix of namespaceWrites) {
    const files = { ...original, 'early-bootstrap.js': entry.replace('var eK=n(84766);', 'var eK=n(84766);' + suffix) };
    new vm.Script(files['early-bootstrap.js']); assert.equal(inspect(assets(files)).state, "invalid", suffix);
  }
  for (const key of ['"recordAndReplay"', "'recordAndReplay'", '`recordAndReplay`', String.raw`"record\u0041ndReplay"`,
    String.raw`'record\u0041ndReplay'`, String.raw`"record\x41ndReplay"`, String.raw`'record\x41ndReplay'`]) {
    const suffix = `;x[${key}]={name:"other"};`;
    const files = { ...original, 'early-bootstrap.js': entry.replace('n.d(t,{},{iR:x});', 'n.d(t,{},{iR:x});' + suffix) };
    new vm.Script(files['early-bootstrap.js']); assert.equal(inspect(assets(files)).state, "invalid", suffix);
  }
  for (const suffix of [
    ';ei.iRL.recordAndReplay=other;',
    ';ei.iRL["recordAndReplay"]=other;',
    ';ei["iRL"]["recordAndReplay"]=other;',
    String.raw`;ei.iRL['record\x41ndReplay']=other;`,
  ]) {
    const files = { ...original, [OWNER]: original[OWNER].replace('var ei=require(40614);', 'var ei=require(40614);' + suffix) };
    new vm.Script(files[OWNER]); assert.equal(inspect(assets(files)).state, "invalid", suffix);
  }
  for (const suffix of [
    ';const note=\'eK["iR"]=other\';',
    ';/* eK["iR"]=other; */',
    ';eK["otherField"]=other;',
    ';{let eK={};eK["iR"]=other;}',
    ';function local(eK){eK["iR"]=other}',
    ';function local(eK){eK[lookup]=other}',
    ';class Local{#state;run(eK=this.#state){eK["iR"]=other}}',
  ]) {
    const files = { ...original, 'early-bootstrap.js': entry.replace('var eK=n(84766);', 'var eK=n(84766);' + suffix) };
    new vm.Script(files['early-bootstrap.js']); const plan = inspect(assets(files)); assert.equal(plan.state, "current", suffix + " " + plan.reason);
  }
  for (const suffix of [';{let x={};x["recordAndReplay"]=other;}', ';x["otherField"]=other;']) {
    const files = { ...original, 'early-bootstrap.js': entry.replace('n.d(t,{},{iR:x});', 'n.d(t,{},{iR:x});' + suffix) };
    new vm.Script(files['early-bootstrap.js']); const plan = inspect(assets(files)); assert.equal(plan.state, "current", suffix + " " + plan.reason);
  }
});

test("Record & Replay plugin gate uses verified rollback after a partial write", t => {
  for (const fatal of [false, true]) {
    const files = filesFixture(), root = extracted(t, files), target = path.join(root, ".vite/build", OWNER), write = fs.writeFileSync;
    let attempted = false;
    fs.writeFileSync = (file, content, ...options) => {
      if (file === target) {
        if (!attempted) { attempted = true; write(file, "partial"); throw Error("inert plugin gate write failure"); }
        if (fatal) throw Error("inert plugin gate rollback failure");
      }
      return write(file, content, ...options);
    };
    try {
      if (fatal) assert.throws(() => run(root), /rollback could not restore original bytes/);
      else assert.equal(run(root).patch.status, "skipped-optional");
    } finally { fs.writeFileSync = write; }
    assert.equal(attempted, true); if (!fatal) assertUnchanged(root, files);
  }
});

for (const [inputVariable, architecture] of [["CODEX_SIGNED_EXTRACTED_APP", "x64"], ["CODEX_SIGNED_ARM64_EXTRACTED_APP", "arm64"]]) {
  test(`Record & Replay existing-row gate through normal API on native input (${inputVariable})`, { skip: !process.env[inputVariable] }, t => {
    const build = path.join(process.env[inputVariable], ".vite/build");
    const files = Object.fromEntries(fs.readdirSync(build).filter(name => /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/u.test(name))
      .map(name => [name, fs.readFileSync(path.join(build, name), "utf8")]));
    assert.equal(Object.keys(files).length, 19);
    const raw = inspect(assets(files)); assert.equal(raw.state, "current", raw.reason); assert.equal(raw.registry.rows.length, 15);
    assert.equal(raw.namespacePublication.expression, "eK.iR"); assert.equal(raw.tablePublication.expression, "x");
    assert.equal(raw.namespace.identity, "40614"); assert.equal(raw.definitions.identity, "84766");
    const root = extracted(t, files); assert.equal(run(root, ["record-and-replay"], architecture).patch.status, "applied");
    const output = readFiles(root), canonical = inspect(assets(output)); assert.equal(canonical.state, "patched", canonical.reason);
    assert.equal(stripCanonical(output[raw.owner.assetName], canonical), files[raw.owner.assetName]);
    assert.deepEqual(Object.keys(files).filter(name => files[name] !== output[name]), [raw.owner.assetName]);
    assertPolicy(raw, canonical);
    assert.equal(run(root, ["record-and-replay"], architecture).patch.status, "already-applied"); assert.deepEqual(readFiles(root), output);
    const spare = Object.keys(files).find(name => name !== raw.owner.assetName && name !== "early-bootstrap.js");
    fs.writeFileSync(path.join(root, ".vite/build", spare), `exports.ids=[999],exports.modules={${raw.factory.identity}(){return false}};`);
    const bad = readFiles(root); assert.equal(run(root, ["record-and-replay"], architecture).patch.status, "skipped-optional"); assertUnchanged(root, bad);
    for (const [name, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(build, name), "utf8"), source);
  });
}
