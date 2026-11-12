"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict"), test = require("node:test");
const fixture = require("./fixtures/current-active-status-module.json"), data = require("./active-status-contracts.json");
const { prepareActiveStatusSource, prepareActiveStatus, inspectActiveStatusOwner, applyActiveStatus, locateActiveStatus } = require("./active-status-owner.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { normalizeDescriptor, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
function carrier(body = fixture.moduleSource, id = fixture.moduleId) { return `export const __rspack_esm_ids=[1];export const __webpack_modules__={${id}(${fixture.params}){${body}}};`; }
function withApp(t, sources = [carrier(), carrier()]) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev"); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "active-status-owner-")), assets = path.join(root, "webview/assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true }); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = sources.map((source, i) => { const file = path.join(assets, "async", i + ".js"); fs.writeFileSync(file, source, { mode: i ? 0o640 : 0o644 }); return file; });
  return { root, assets, files };
}
test("native published row and indicator patch exactly once and invert only their scalar", () => {
  const source = carrier(), patched = prepareActiveStatusSource(source);
  assert.notEqual(patched, source); assert.equal(Buffer.byteLength(patched) - Buffer.byteLength(source), 39);
  assert.equal(prepareActiveStatusSource(patched), patched);
  const copy = [...rspackModuleFactories(patched, "source.js")][0], inverse = inspectActiveStatusOwner(copy);
  assert.equal(inverse.state, "patched"); assert.equal(inverse.nativeSource, fixture.moduleSource);
  assert.equal(copy.moduleSource, inverse.patchedSource); new vm.Script(patched.replaceAll("export const ", "const "));
});
test("coherent longer factory/function aliases preserve native indicator identity", () => {
  const source = carrier(), lex = createJavaScriptLexicalIndex(source), aliases = { ea: "nativeActivityIndicator", e_: "publishedConversationRow", eU: "nativeConversationRow", ee: "nativeActivityStyles", et: "nativeActivityLabels" };
  const renamed = source.replace(/[A-Za-z_$][\w$]*/gu, (name, at) => lex.isCode(at) && source[at - 1] !== "." && Object.hasOwn(aliases, name) ? aliases[name] : name);
  const patched = prepareActiveStatusSource(renamed); assert.notEqual(patched, renamed); assert.equal(prepareActiveStatusSource(patched), patched);
});
test("missing, dead, captured, wrong-key, wrong-provider and partial state fail closed", () => {
  const source = carrier(), patched = prepareActiveStatusSource(source);
  const bad = [
    source.replace("E:()=>e_", "E:()=>eR"), source.replace("E:()=>e_", 'E:()=>e_,"E":()=>eR'),
    source.replace("function ea(e){", "if(false){function ea(e){").replace("function eU(e){", "}function eU(e){"),
    source.replace("(m.nX,h)", "(m.nX,foreignConversation)"),
    source.replace("conversationId:r})}:null", "conversationId:foreignConversation})}:null"),
    source.replace('m=a("tl5a")', 'm=a("foreign")'),
    source.replace('o=a("QosV")', 'o=a("foreign")'),
    source.replace("function ea(e){", "function ea(e){let m;"),
    source.replace("function e_(e){", "eU=()=>null;function e_(e){"),
    source.replace('id:"active-status"', 'id:"unused-status"'),
    source.replace("extraIconBadges:au", "extraIconBadges:foreignBadges"),
    source.replace(",th}", ",eq,null}"),
    patched.replace("/*codexLinuxRemoteMobileActiveStatus*/", ""),
    patched.replace('"active":null==', '"inactive":null=='),
    source + "/*codexLinuxRemoteMobileActiveStatus*/",
  ];
  for (const input of bad) { assert.notEqual(input, source); new vm.Script(input.replaceAll("export const ", "const ")); assert.throws(() => prepareActiveStatusSource(input)); }
});
test("all physical peers commit atomically, restore modes and reject hidden drift", t => {
  const { root, files } = withApp(t), before = files.map(f => fs.readFileSync(f)), modes = files.map(f => fs.statSync(f).mode);
  let writes = 0;
  assert.throws(() => applyActiveStatus(root, { writeFileSync(file, bytes) { if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 7)); throw Error("controlled indicator write failure"); } fs.writeFileSync(file, bytes); } }), /controlled indicator write failure/);
  assert.deepEqual(files.map(f => fs.readFileSync(f)), before); assert.deepEqual(files.map(f => fs.statSync(f).mode), modes);
  assert.equal(applyActiveStatus(root).changed, 2); assert.equal(applyActiveStatus(root).changed, 0);
  const first = fs.readFileSync(files[0]); fs.writeFileSync(files[1], carrier().replace("Read-only snapshot", "hidden damaged peer"));
  assert.throws(() => applyActiveStatus(root)); assert.deepEqual(fs.readFileSync(files[0]), first);
});
test("mixed states, foreign identities, stale snapshots and stale commit plans preserve bytes", t => {
  const native = carrier(), patched = prepareActiveStatusSource(native);
  for (const sources of [[native, patched], [native, carrier(fixture.moduleSource, "ForeignOwner")]]) {
    const { root, files } = withApp(t, sources), before = files.map(f => fs.readFileSync(f)); assert.throws(() => applyActiveStatus(root)); assert.deepEqual(files.map(f => fs.readFileSync(f)), before);
  }
  const { assets, files } = withApp(t), plan = locateActiveStatus(assets); fs.appendFileSync(files[1], "/*concurrent*/");
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  const copy = [...rspackModuleFactories(native, "source.js")][0]; copy.start++; assert.throws(() => prepareActiveStatus([copy]), /snapshot/);
});
test("selected presentation and selector member authority rejects later writers and deletes", () => {
  const mutations = [
    'ee.active="wrong-presentation";', 'ee["active"]="wrong-presentation";', 'delete et["active"];',
    'delete (et)?.["active"];', '(ee).active="wrong-presentation";', 'm["nX"]=m.hf;',
    'delete (m).F9;', 'm[unknownKey]=m.hf;', 'Object.assign(ee,{active:"wrong"});', 'Reflect.set(m,"nX",m.hf);',
    '(ee.active)="wrong";', '((m["nX"]))=m.hf;', '++(ee.active);',
    '[ee.active]=["wrong"];', '({active:ee.active}={active:"wrong"});',
    'Object["assign"](ee,{active:"wrong"});', 'Reflect["set"](m,"nX",m.hf);',
    'function later(){(ee.active)="wrong";}', 'const later=()=>((m["nX"]))=m.hf;',
    'const later=()=>{[ee.active]=["wrong"];};', 'class Later{write(){++(ee.active);}}',
    'Object[unknownMutator](ee,{active:"wrong"});',
  ];
  for (const mutation of mutations) {
    const input = carrier(fixture.moduleSource + mutation); new vm.Script(input.replaceAll("export const ", "const "));
    assert.throws(() => prepareActiveStatusSource(input));
  }
  for (const control of [
    'function unrelatedPresentation(){let ee={};(ee.active)="unrelated";}',
    'function unrelatedSelector(m){((m["nX"]))=m.hf;}',
    'void (ee.active);void ((m["nX"]));Object.keys(ee);Reflect.get(m,"nX");',
    'const later=()=>((ee.active));class Reader{read(){return (m["nX"]);}}',
  ]) {
    const unrelated = carrier(fixture.moduleSource + control);
    assert.notEqual(prepareActiveStatusSource(unrelated), unrelated);
  }
});
test("native visibility atom, store scope and flag-provider identities remain closed", () => {
  const nativeGateCell = data.gateCell.replace("let J=", "let $=");
  const mutations = [
    fixture.moduleSource.replace(nativeGateCell, nativeGateCell.replace("!1", "!0")),
    fixture.moduleSource.replace('ew=a("hZax")', 'ew=a("wrong-provider")'),
    fixture.moduleSource.replace('F=a("OWtl")', 'F=a("wrong-provider")'),
    fixture.moduleSource + '$=foreignGate;',
    fixture.moduleSource.replace('var Y=a("slpy");', 'return;var Y=a("slpy");'),
  ];
  for (const body of mutations) { assert.notEqual(body, fixture.moduleSource); assert.throws(() => prepareActiveStatusSource(carrier(body))); }
});
test("registered current-conversation descriptor owns native peers and reports actual drift", t => {
  const { root, files } = withApp(t), raw = require("./patch.js").find(d => d.id === "linux-remote-mobile-active-status");
  assert.equal(raw.phase, "extracted-app:pre-webview"); assert.equal(raw.order, 20_160); assert.equal(raw.ciPolicy, "optional");
  const descriptor = normalizeDescriptor({ ...raw, id: "feature:remote-mobile-control:" + raw.id, featureId: "remote-mobile-control" });
  const run = () => { const report = createPatchReport(); applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, raw.phase); return report.patches; };
  assert.equal(run()[0].status, "applied"); assert.equal(run()[0].status, "already-applied");
  const first = fs.readFileSync(files[0]); fs.writeFileSync(files[1], carrier().replace("(m.hf,h)", "(m.F9,h)"));
  t.mock.method(console, "warn", () => {}); assert.equal(run()[0].status, "skipped-optional"); assert.deepEqual(fs.readFileSync(files[0]), first);
});
module.exports = { carrier };
