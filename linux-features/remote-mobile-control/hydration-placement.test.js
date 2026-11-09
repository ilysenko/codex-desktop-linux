"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const { nativeCarrier } = require("./fixtures/hydration-native-carrier.js");
const data = require("./hydration-contract-data.json");
const { prepareHydrationSource, applyHydration, locateHydration } = require("./hydration-owner.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { normalizeDescriptor, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");

function withApp(t, sources = [nativeCarrier(), nativeCarrier()]) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "hydration-owner-")), assets = path.join(root, "webview/assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = sources.map((s, i) => { const f = path.join(assets, "async", `${i}.js`); fs.writeFileSync(f, s, { mode: i ? 0o640 : 0o644 }); return f; });
  return { root, assets, files };
}

test("published native discovery carrier applies once with the established guard output", () => {
  const native = nativeCarrier(), patched = prepareHydrationSource(native);
  assert.notEqual(patched, native);
  assert.equal(Buffer.byteLength(patched) - Buffer.byteLength(native), 177);
  assert.equal(prepareHydrationSource(patched), patched);
  new vm.Script(patched.replaceAll("export const ", "const "));
});

test("native role aliases remain independent of minified symbol spelling", () => {
  const source = nativeCarrier(), lex = createJavaScriptLexicalIndex(source);
  const names = { i9: "discoveryOwner", rD: "nativeQueue", eM: "threadIdFromPayload", sD: "publishedManager", g: "nativeThreadIds", D: "mergeHydratedTurns", iK: "applyResolvedRequest", rx: "hydratedText", rM: "deltaIdentity", k: "canonicalTurnReader", N: "canonicalIslands", R: "nativeMergeProvider" };
  const renamed = source.replace(/[A-Za-z_$][\w$]*/gu, (name, at) => lex.isCode(at) && source[at - 1] !== "." && Object.hasOwn(names, name) ? names[name] : name);
  const patched = prepareHydrationSource(renamed);
  assert.notEqual(patched, renamed);
  assert.equal(prepareHydrationSource(patched), patched);
});

test("orphan, dead, captured, partial and split native authorities reject", () => {
  const native = nativeCarrier(), patched = prepareHydrationSource(native);
  const withoutBase = native.replace('p=n("Fkn8"),', "");
  const lateBaseImport = withoutBase.slice(0, -3) + ';var p=n("Fkn8");' + withoutBase.slice(-3);
  const bad = [
    native.replace("O3:()=>sD", "Other:()=>sD"),
    native.replace("O3:()=>sD", 'O3:()=>sD,"O3":()=>Foreign'),
    native.replace("class i9{", "if(false){class i9{").replace("class sD extends", "}class sD extends"),
    native.replace("hydrate(e,t,n){", "differentHydrate(e,t,n){"),
    native.replace("release(e,t,n,r,i){", "differentRelease(e,t,n,r,i){"),
    native.replace('g=n("E7Ps")', 'g=n("wrong-provider")'),
    native.replace('em=n("N2rm")', 'em=n("DBCl")'),
    native.replace("this.threadDiscovery.bufferRequest(", "this.otherDiscovery.bufferRequest("),
    native.replace("this.threadDiscovery=new i9", "this.threadDiscovery=new OtherDiscovery"),
    native.replace("clear();if(this.lifecycle.addAuthStatusCallback", "clear();if(false&&this.lifecycle.addAuthStatusCallback"),
    native.replace("function D(e,t){", "function D(e,t){return [];"),
    native.replace('var g=n("E7Ps")', 'let Map=class{};var g=n("E7Ps")'),
    native.replace("class i9{", "return;class i9{"),
    native.replace("class sD extends", "i9=class{};class sD extends"),
    native.replace("this.threadDiscovery.bufferRequest(e,this.runtimeSettings,this.runtime)", "(this.threadDiscovery=null,this.threadDiscovery.bufferRequest(e,this.runtimeSettings,this.runtime))"),
    patched.replace("/*codexLinuxRemoteMobileConversationHydration*/", ""),
    patched.replace('"item/completed"!==n.method', '"item/foreign"!==n.method'),
    native + "/*codexLinuxRemoteMobileConversationHydration*/",
    native.slice(0, -4) + '["onNotification"](){return null}' + native.slice(-4),
    native.slice(0, -4) + 'onNotification=()=>null;' + native.slice(-4),
    native.slice(0, -4) + '"onRequest"(){return null}' + native.slice(-4),
    native.slice(0, -4) + '["on"+"Notification"](){return null}' + native.slice(-4),
    native.replace('var g=n("E7Ps")', 'Map=WeakMap;var g=n("E7Ps")'),
    native.replace("Math.min(", "WeakMap.min("),
    native.replace("constructor(e){super();let Q;", "constructor(e){super();let Q;var i9=class{};"),
    native.replace("constructor(e){super();let Q;", "constructor(e){super();let Q;i9=class{};"),
    native.replace("let n=k(e);", "let n=foreignCanonicalReader(e);"),
    lateBaseImport,
    native.replace("getHostId(){return this.hostId}", "getHostId(){return 'local'}"),
    native.replace("getHostId(){return this.hostId}", "getHostId(){return 'always-wrong-host'}"),
    native.replace("this.hostId=b,this.isCloudHost=", "this.hostId='local',this.isCloudHost="),
    native.slice(0, -4) + '["getHostId"](){return "local"}' + native.slice(-4),
    ...["delete this.hostId;", 'delete this["hostId"];', "delete(this.threadDiscovery);", "delete this[unknownProperty];",
      "delete (this).hostId;", 'delete ((this))["hostId"];', "delete this?.hostId;", 'delete this?.["threadDiscovery"];',
      "delete /*operation*/ (/*receiver*/this/*close*/) /*access*/ . /*key*/ hostId;"].map(operation =>
      native.replace(data.hostInitialization + ";", data.hostInitialization + ";" + operation)),
    ...["threadDiscovery", "notificationReductionContext", "hostId", "isCloudHost"].map(field =>
      native.replace(data.requestHead + ")||noop();}", data.requestHead + `)||noop();delete this.${field};}`)),
  ];
  for (const source of bad) {
    assert.notEqual(source, native);
    new vm.Script(source.replaceAll("export const ", "const "));
    assert.throws(() => prepareHydrationSource(source));
  }
});

test("deleting a proven unrelated literal field retains the native ownership proof", () => {
  for (const operation of ['delete this["unrelated"];', 'delete (this)?.["unrelated"];', "delete (this).unrelated;"]) {
    const source = nativeCarrier().replace(data.hostInitialization + ";", data.hostInitialization + ";" + operation);
    assert.notEqual(prepareHydrationSource(source), source);
  }
});

test("every physical peer commits atomically with modes, idempotence and rollback", t => {
  const { root, assets, files } = withApp(t), before = files.map(f => fs.readFileSync(f)), modes = files.map(f => fs.statSync(f).mode);
  let writes = 0;
  assert.throws(() => applyHydration(root, { writeFileSync(file, bytes) { if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 7)); throw Error("controlled hydration write failure"); } fs.writeFileSync(file, bytes); } }), /controlled hydration write failure/);
  assert.deepEqual(files.map(f => fs.readFileSync(f)), before);
  assert.deepEqual(files.map(f => fs.statSync(f).mode), modes);
  assert.equal(applyHydration(root).changed, 2);
  assert.equal(applyHydration(root).changed, 0);
  const patched = files.map(f => fs.readFileSync(f, "utf8"));
  fs.writeFileSync(files[1], nativeCarrier().replace("Failed to discover thread from event", "hidden damaged owner"));
  assert.throws(() => applyHydration(root));
  assert.equal(fs.readFileSync(files[0], "utf8"), patched[0]);
  fs.writeFileSync(files[1], patched[1]);
  const plan = locateHydration(assets);
  fs.appendFileSync(files[1], "/*concurrent edit*/");
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
  assert.equal(fs.readFileSync(files[0], "utf8"), patched[0]);
});

test("mixed states and unknown owner identities preserve all physical inputs", t => {
  for (const sources of [[nativeCarrier(), prepareHydrationSource(nativeCarrier())], [nativeCarrier(), nativeCarrier("ForeignOwner")]]) {
    const { root, files } = withApp(t, sources), before = files.map(f => fs.readFileSync(f));
    assert.throws(() => applyHydration(root));
    assert.deepEqual(files.map(f => fs.readFileSync(f)), before);
  }
});

test("the registered hydration descriptor owns complete native peers and reports actual failure", t => {
  const { root, files } = withApp(t);
  const raw = require("./patch.js").find(d => d.id === "linux-remote-mobile-conversation-hydration");
  assert.equal(raw.phase, "extracted-app:pre-webview");
  assert.equal(raw.order, 20_151);
  assert.equal(raw.ciPolicy, "optional");
  assert.equal(raw.assetMatch, undefined);
  const descriptor = normalizeDescriptor({ ...raw, id: "feature:remote-mobile-control:" + raw.id, featureId: "remote-mobile-control" });
  const run = () => { const report = createPatchReport(); applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, raw.phase); return report.patches; };
  assert.equal(run()[0].status, "applied");
  assert.equal(run()[0].status, "already-applied");
  const before = fs.readFileSync(files[0]);
  fs.writeFileSync(files[1], nativeCarrier().replace("bufferNotification(e,t){", "foreignNotification(e,t){"));
  t.mock.method(console, "warn", () => {});
  assert.equal(run()[0].status, "skipped-optional");
  assert.deepEqual(fs.readFileSync(files[0]), before);
});
