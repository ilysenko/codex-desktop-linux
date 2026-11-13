"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyExpandedPatch: apply, expandedDescriptor: descriptor, reasoningComponent } = require("./expanded.js");
const { RUNTIME } = require("./runtime.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const {fixture,harness}=require("./expanded.test-helpers.js");

test("actual native component expands empty-start streams on completion and retains manual fold/reopen", () => {
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(apply(patched), patched);
  assert.equal(javascriptSourceParses(patched), true);
  const app = harness(patched);
  const item = { type: "reasoning", id: "summary", completed: false, content: "" };
  assert.equal(app.render(item).scroll, undefined);
  item.content = "Actual model summary";
  let result = app.render(item);
  assert.equal(result.scroll.autoScrollToBottom, true);
  assert.equal(result.markdown.children, item.content);
  item.completed = true;
  result = app.render(item);
  assert.equal(result.scroll.autoScrollToBottom, false);
  assert.equal(result.disclosure.expanded, true);
  assert.equal(result.markdown.children, item.content);
  result.disclosure.onToggle();
  result = app.render(item);
  assert.equal(result.scroll, undefined);
  assert.equal(result.disclosure.expanded, false);
  result.disclosure.onToggle();
  assert.equal(app.render(item).disclosure.expanded, true);
  assert.equal(harness(patched).render(item).disclosure.expanded, true, "reopened history starts expanded");
});

test("no completed body, disabled preference, native resumed streams, and manual native behavior are preserved", () => {
  const patched = apply(fixture);
  const empty = { type: "reasoning", completed: true, content: "" };
  assert.equal(JSON.stringify(harness(patched).render(empty).tree), JSON.stringify(harness(fixture).render(empty).tree));
  const item = { type: "reasoning", completed: true, content: "Available body" };
  const original = harness(fixture), disabled = harness(patched, { enabled: false });
  let before = original.render(item), after = disabled.render(item);
  assert.equal(JSON.stringify(after.tree), JSON.stringify(before.tree));
  before.disclosure.onToggle();
  after.disclosure.onToggle();
  assert.equal(JSON.stringify(disabled.render(item).tree), JSON.stringify(original.render(item).tree));
  for (const resume of [null, "resumed", "paused"]) {
    const stream = { type: "reasoning", completed: false, content: "**Heading** Real streamed summary" };
    const before = harness(fixture, { resume }).render(stream);
    const after = harness(patched, { resume }).render(stream);
    assert.equal(JSON.stringify(after.tree), JSON.stringify(before.tree));
    if (resume !== "paused") assert.equal(after.scroll.autoScrollToBottom, true);
  }
});

test("expanded native contract rejects partial state/body guards, changed callbacks, and inaccessible runtimes", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(fixture), body = patched.replace(RUNTIME + "\n", "");
  const sourceCases = [
    "const unrelated=true;", fixture + fixture, patched + fixture,
    patched.replace("/*community-reasoning-visibility-expanded*/", ""),
    patched.replace("/*community-reasoning-visibility-expanded-body*/", ""),
    patched.replace('&&(!codexLinuxReasoningVisibilityEnabled()||!!L)/*community-reasoning-visibility-expanded-body*/', ""),
    patched.replace("onToggle:()=>{E(aM)}", "onToggle:()=>{other(aM)}"),
    patched.replace("autoScrollToBottom:R", "autoScrollToBottom:!1"),
    patched.replace(RUNTIME, ""), RUNTIME + patched,
    body + `;function unused(){${RUNTIME}}`, body + `;if(false){${RUNTIME}}`,
    `export const __webpack_modules__={Owner(e,t,n){${body}},Sibling(e,t,n){${RUNTIME}}};`,
    fixture + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}",
  ];
  for (const source of sourceCases) {
    assert.notEqual(source, fixture);
    assert.equal(apply(source), source);
  }
});

function asChunk(source) {
  return source.includes("export const __webpack_modules__=") ? source : `export const __rspack_esm_ids=[101];export const __webpack_modules__={Owner(e,t,n){${source}}};`;
}

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-expanded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, asChunk(source));
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, [descriptor], {}, report, "extracted-app:pre-webview");
    return report.patches[0];
  };
  return { write, run };
}

test("expanded complete state accepts own-factory helpers with legitimate outer/sibling copies", t => {
  const body = apply(fixture).replace(RUNTIME + "\n", "");
  const component = /^function ([\w$]+)\(/.exec(reasoningComponent(body).text)[1];
  for (const outer of ["", RUNTIME]) {
    const source = `${outer}export const __webpack_modules__={Owner(e,t,n){${RUNTIME}${body};return ${component}},Sibling(e,t,n){${RUNTIME}}};`;
    assert.equal(apply(source), source);
    assert.equal(harness(source).render({ completed: true, content: "Available" }).disclosure.expanded, true);
    const { write, run } = workspace(t);
    const file = write("async/own-helper.js", source);
    assert.equal(run().status, "already-applied");
    assert.equal(fs.readFileSync(file, "utf8"), asChunk(source));
  }
});

test("expanded production descriptor rejects ambiguous and wrong-scope copies without writes", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t);
  const first = write("async/366297.hash.js", fixture);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(first, "utf8");
  assert.equal(run().status, "already-applied");
  const misplaced = patched.replace(RUNTIME + "\n", "") + `;function unused(){${RUNTIME}}`;
  const second = write("other/366297.hash.js", misplaced);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(first, "utf8"), patched);
  assert.equal(fs.readFileSync(second, "utf8"), asChunk(misplaced));
  fs.writeFileSync(first, "const unrelated=true;");
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(second, "utf8"), asChunk(misplaced));
});

test("signed current native component patches idempotently through production descriptor", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const owners = listWebviewAssetFiles(assets, /\.js$/).map(assetName => ({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")})).filter(({source}) => descriptor.assetMatch(source));
  assert.equal(owners.length,1);
  const owner=owners[0];
  const native = reasoningComponent(owner.source);
  assert.ok(fixture.startsWith(native.text), "fixture must match the actual current component body");
  const { write, run } = workspace(t);
  const file = write(owner.assetName, owner.source);
  assert.equal(run().status, "applied");
  assert.equal(javascriptSourceParses(fs.readFileSync(file, "utf8")), true);
  assert.equal(run().status, "already-applied");
  assert.equal(fs.readFileSync(path.join(assets, owner.assetName), "utf8"), owner.source);
});


test("expanded rejects inactive or changed callable owners before any source write", t => {
  t.mock.method(console,"warn",()=>{});
  for (const modified of [
    fixture.replace("function aS(e)","async function aS(e)"),
    fixture.replace("function aS(e)","async/*gap*/function aS(e)"),
    fixture.replace("function aS(e)","function* ak(e)"),
    fixture.replace("function aS(e)","const unused=function aS(e)").replace("}\nfunction aM", "};\nfunction aM"),
  ]) {
    assert.notEqual(modified,fixture);
    assert.equal(javascriptSourceParses(modified),true);
    assert.equal(apply(modified),modified);
    const {write,run}=workspace(t),before=asChunk(modified),file=write("async/inactive.js",modified);
    assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),before);
  }
});

test("expanded cohort refuses same-ID hidden, string-decoy, and mixed copies atomically", t => {
  t.mock.method(console,"warn",()=>{});
  const missing=fixture.replace('key:"reasoning-markdown"','key:"retired-reasoning"');
  const decoy=missing+';const note=\'key:"reasoning-markdown"\';';
  for(const second of [missing,decoy,apply(fixture)]) {
    const {write,run}=workspace(t),a=write("async/a.js",fixture),b=write("async/b.js",second);
    assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(a,"utf8"),asChunk(fixture));assert.equal(fs.readFileSync(b,"utf8"),asChunk(second));
  }
});

test("expanded plans complete same-ID copies and rolls back a later truncated write", t => {
  t.mock.method(console,"warn",()=>{});
  const {write,run}=workspace(t),a=write("async/a.js",fixture),b=write("async/b.js",fixture);
  const original=fs.writeFileSync;let failed=false;
  t.mock.method(fs,"writeFileSync",(file,bytes,...args)=>{
    if(file===b&&!failed){failed=true;original(file,"truncated");throw Error("injected expanded write failure");}
    return original(file,bytes,...args);
  });
  assert.equal(run().status,"skipped-optional");assert.equal(failed,true);
  assert.equal(fs.readFileSync(a,"utf8"),asChunk(fixture));assert.equal(fs.readFileSync(b,"utf8"),asChunk(fixture));
  assert.equal(run().status,"applied");assert.equal(run().status,"already-applied");
});


test("actual expanded owner preserves every other source byte and refuses hidden copies",{skip:!process.env.CODEX_SIGNED_EXTRACTED_APP},t=>{
  t.mock.method(console,"warn",()=>{});
  const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js"),app=process.env.CODEX_SIGNED_EXTRACTED_APP;
  const names=findWebviewAssetsContaining(app,['key:"reasoning-markdown"']);assert.equal(names.length,1);
  const original=fs.readFileSync(path.join(app,"webview/assets",names[0]),"utf8"),patched=apply(original);
  const restored=patched.replace(RUNTIME+"\n","")
    .replace("codexLinuxReasoningVisibilityEnabled()/*community-reasoning-visibility-expanded*/","!1")
    .replace("&&(!codexLinuxReasoningVisibilityEnabled()||!!L)/*community-reasoning-visibility-expanded-body*/","");
  assert.equal(restored,original);
  const missing=original.replace('key:"reasoning-markdown"','key:"retired-reasoning"');
  for(const other of [missing,missing+';const note=\'key:"reasoning-markdown"\';',patched,
    original.replace("function aS(e)","async/*gap*/function aS(e)")]) {
    assert.equal(javascriptSourceParses(other),true);
    const project=workspace(t),a=project.write("async/current.js",original),b=project.write("async/hidden.js",other);
    assert.equal(project.run().status,"skipped-optional");
    assert.equal(fs.readFileSync(a,"utf8"),original);assert.equal(fs.readFileSync(b,"utf8"),other);
  }
  assert.equal(fs.readFileSync(path.join(app,"webview/assets",names[0]),"utf8"),original);
});

test("disabled expanded feature performs no source discovery",t=>{
  const {loadLinuxFeaturePatchDescriptors}=require("../../scripts/lib/linux-features.js");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"expanded-disabled-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,"features.json");fs.writeFileSync(config,JSON.stringify({enabled:[]}));
  const descriptors=loadLinuxFeaturePatchDescriptors({featuresRoot:path.join(__dirname,".."),featuresConfigPath:config});assert.deepEqual(descriptors,[]);
  let called=false;t.mock.method(fs,"readdirSync",()=>{called=true;throw Error("unexpected expanded inventory")});
  const report=createPatchReport();applyExtractedAppPatchDescriptors(root,descriptors,{},report,"extracted-app:pre-webview");
  assert.deepEqual(report.patches,[]);assert.equal(called,false);
});


test("expanded does not treat a returned named function expression as a declaration",t=>{
  t.mock.method(console,"warn",()=>{});
  const input=asChunk(fixture).replace("Owner(e,t,n){","Owner(e,t,n){return ");
  assert.equal(javascriptSourceParses(input),true);
  assert.equal(reasoningComponent(input),null);assert.equal(apply(input),input);
  const {write,run}=workspace(t),file=write("async/returned.js",input);
  assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),input);
});


test("expanded requires the stable component binding and live returned Collapse continuation",t=>{
  t.mock.method(console,"warn",()=>{});
  for(const input of [
    fixture+";aS=()=>null;",
    fixture+";"+String.fromCharCode(92)+"u0061S=()=>null;",
    fixture.replace("expanded:U,children:C","expanded:!1,children:C"),
    fixture.replace("children:[y,j]","children:[y,C]"),
    fixture.replace("children:[y,j]","children:[j,y]"),
    fixture.replace("children:[y,j]","header:y,body:j"),
    fixture.replace("externalDisclosure:g","externalDisclosure:foreign"),
    fixture.replace("g=O?{expanded:D","g=O?{expanded:foreign"),
    fixture.replace("I[38],A}","I[38],null}"),
    fixture.replace("return I[17]","return null;I[17]"),
  ]) {
    assert.notEqual(input,fixture);assert.equal(javascriptSourceParses(input),true);
    assert.equal(apply(input),input);
    const {write,run}=workspace(t),file=write("async/disconnected.js",input);
    assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),asChunk(input));
  }
  const alias=fixture.replace(/\baS\b/gu,"CurrentReasoning$");
  assert.notEqual(apply(alias),alias);
});
