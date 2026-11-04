"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { applyAuthoredMessageVisibilityPatch: apply, descriptors } = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

// Current signed-package partition and classifier, anchored by semantics rather
// than the bundle filename or minified aliases.
const fixture = "const xO=function(e,{hasFollowingFinalAnswer:t=!1,isTurnInProgress:n=!1,keepMcpAppEntriesPersistent:s=!1,mcpServerStatuses:a,renderMcpApps:i=!1}={}){let o=[],l=[],r=[],c=[],d=null,u=t?e.length:e.findLastIndex(e=>\"standalone\"===e.kind&&\"assistant-message\"===e.item.item.type&&(0,p.rt)(e.item.item));for(let[t,m]of e.entries()){if(\"standalone\"===m.kind&&\"worked-for\"===m.item.item.type){d=m.item.item;continue}if(\"standalone\"===m.kind&&\"realtime-transcript\"===m.item.item.type){0===l.length?c.push(m):(l.push(m),r.push(m));continue}l.push(m),n&&u>=0&&t>u||function({unit:e,hasFollowingFinalAnswer:t,keepMcpAppEntriesPersistent:n,mcpServerStatuses:s,renderMcpApps:a}){if(\"standalone\"!==e.kind)return!1;let i=e.item.item;return\"user-input-response\"===i.type?!i.completed:!!(\"mcp-tool-call\"===i.type&&(0,g.o)(i)||\"assistant-message\"===i.type&&(0,p.Yr)(i)||\"dynamic-tool-call\"===i.type&&(0,h.Q1)(i)||n&&a&&\"mcp-tool-call\"===i.type&&function({item:e,mcpServerStatuses:t}){let n=e.result?.type===\"success\"?e.result.raw:null;return(!e.completed||null!=e.result)&&(null!=e.mcpAppResourceUri||null!=(0,f.i$)({mcpServerStatuses:t,server:e.invocation.server,tool:e.invocation.tool,toolResult:n}))}({item:i,mcpServerStatuses:s}))||\"user-message\"===i.type&&(\"pending\"===i.steeringStatus||!0===i.followsInterruptedFinalAnswer||!0===i.wasInHistoryPreview||\"not-sent\"===i.deliveryStatus||!0===i.hookFeedback||!t)}({unit:m,hasFollowingFinalAnswer:t<u,keepMcpAppEntriesPersistent:s,mcpServerStatuses:a,renderMcpApps:i})?r.push(m):o.push(m)}return{collapsibleUnits:o,expandedUnits:l,persistentUnits:r,preToggleUnits:c,workedForItem:d}};";
function partition(source, units, options, reasoningEnabled = false) {
  return vm.runInNewContext(source + ";xO", {
    g: { o: item => item.persist },
    p: { Yr: item => item.final, rt: item => item.final },
    h: { Q1: item => item.interactive },
    f: { i$: ({ toolResult }) => toolResult?.interactive ? {} : null },
    localStorage: { getItem: () => reasoningEnabled ? "1" : null },
  })(units, options);
}
const unit = (type, id, extra = {}) => ({kind:"standalone",item:{item:{type,id,completed:true,invocation:{server:"test",tool:"tool"},result:{type:"success",raw:{interactive:extra.interactive}},...extra}}});
const ids = units => Array.from(units, unit => unit.item.item.id);

test("commentary stays visible in order while tools collapse; expansion contains each item once", () => {
  const units = [unit("assistant-message","c1"),unit("exec","tool"),unit("user-message","steering",{steeringStatus:"accepted"}),unit("assistant-message","c2"),unit("user-message","ordinary"),unit("user-message","interrupted",{followsInterruptedFinalAnswer:true}),unit("user-message","hook",{hookFeedback:true})];
  assert.deepEqual(ids(partition(fixture,units,{hasFollowingFinalAnswer:true}).persistentUnits), ["steering","interrupted","hook"]);
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  assert.doesNotThrow(() => new vm.Script(patched));
  for (let toggle = 0; toggle < 3; toggle++) {
    const result = partition(patched, units);
    assert.deepEqual(ids(result.persistentUnits), ["c1","steering","c2","ordinary","interrupted","hook"]);
    assert.deepEqual(ids(result.collapsibleUnits), ["tool"]);
    assert.deepEqual(ids(result.expandedUnits), ids(units));
  }
  assert.equal(apply(patched), patched);
});

test("tool exceptions, grouped activity and worked-for handling remain upstream-owned", () => {
  const tools = [unit("exec","exec"),unit("dynamic-tool-call","dynamic",{interactive:true}),unit("mcp-tool-call","mcp",{interactive:true}),unit("mcp-tool-call","persisted",{persist:true}),unit("user-input-response","pending",{completed:false}),unit("user-input-response","completed"),unit("worked-for","duration")];
  const options = {hasFollowingFinalAnswer:true,keepMcpAppEntriesPersistent:true,renderMcpApps:true};
  assert.equal(JSON.stringify(partition(apply(fixture),tools,options)),JSON.stringify(partition(fixture,tools,options)));
  const group = {kind:"group",items:[]};
  assert.equal(partition(apply(fixture),[group]).collapsibleUnits[0],group);
});

test("turns without tools and history replay preserve authored messages without duplication", () => {
  const units = [unit("user-message","user"),unit("assistant-message","commentary"),unit("assistant-message","final",{final:true})];
  const unchanged = JSON.stringify(units);
  for (const options of [{hasFollowingFinalAnswer:true},{isTurnInProgress:true},{}]) {
    const result = partition(apply(fixture),units,options);
    assert.deepEqual(ids(result.persistentUnits),["user","commentary","final"]);
    assert.deepEqual(ids(result.expandedUnits),["user","commentary","final"]);
    assert.equal(result.collapsibleUnits.length,0);
    assert.equal(JSON.stringify(units),unchanged);
  }
});

test("missing, duplicate, mixed and changed classifiers remain byte-identical with actionable warnings", () => {
  const patched = apply(fixture);
  const partialAssistant = fixture.replace('"assistant-message"===i.type&&(0,p.Yr)(i)', '"assistant-message"===i.type');
  const partialUser = patched.replace('"assistant-message"===i.type||', '"assistant-message"===i.type&&(0,p.Yr)(i)||');
  const retiredShape = fixture.replace('if("standalone"!==e.kind)', 'if(e.kind!==`standalone`)');
  for (const source of ["",fixture+fixture,patched+patched,fixture+patched,partialAssistant,partialUser,retiredShape,
    fixture.replace('"not-sent"===i.deliveryStatus','"queued"===i.deliveryStatus'),fixture.replace("i=e.item.item","i=e.item.other"),
    fixture.replace("toolResult:n", "toolResult:unknown"),
    fixture.replace("mcpServerStatuses:t,server:e.invocation.server", "mcpServerStatuses:unknown,server:e.invocation.server"),
    fixture.replace("server:e.invocation.server", "server:unknown.invocation.server"),
    fixture.replace("e.result.raw:null", "unknown.result.raw:null"),
    fixture.replace("item:i,mcpServerStatuses:s", "item:unknown,mcpServerStatuses:s")]) {
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value,source);
    assert.equal(result.warnings.length,1);
    assert.match(result.warnings[0],/Disable authored-message-visibility and rebuild/);
  }
});

test("a valid classifier never hides a second drifted or partially applied classifier", () => {
  for (const drifted of [
    fixture.replace('"not-sent"===i.deliveryStatus','"queued"===i.deliveryStatus'),
    fixture.replace("toolResult:n","toolResult:unknown"),
    apply(fixture).replace('"assistant-message"===i.type||','"assistant-message"===i.type&&(0,p.Yr)(i)||'),
  ]) {
    const source=`export const __webpack_modules__={Good(e){${fixture}},Drifted(e){${drifted}}};`;
    assert.ok(javascriptSourceParses(source));
    const result=captureWarnings(()=>apply(source));
    assert.equal(result.value,source);assert.equal(result.warnings.length,1);
    assert.match(result.warnings[0],/of 2/);
  }
});

test("authored visibility keeps the existing reasoning prefix in both application orders", () => {
  const reasoning = require("../reasoning-visibility/patch.js").descriptors.find(descriptor=>descriptor.id==="persistent");
  const first=reasoning.apply(apply(fixture));
  const second=apply(reasoning.apply(fixture));
  assert.equal(first,second);
  assert.equal(apply(first),first);
  assert.equal(reasoning.apply(first),first);
  const units=[unit("user-message","user"),unit("reasoning","summary"),unit("exec","tool"),unit("assistant-message","commentary")];
  assert.deepEqual(ids(partition(first,units,{hasFollowingFinalAnswer:true},true).persistentUnits),["user","summary","commentary"]);
  assert.deepEqual(ids(partition(first,units,{hasFollowingFinalAnswer:true},false).persistentUnits),["user","commentary"]);
});

test("classifier aliases can change without changing behavior", () => {
  const source = fixture.replace(/(?<![\w$])i(?![\w$])/g,"itemAlias");
  assert.deepEqual(ids(partition(apply(source),[unit("assistant-message","c")] ).persistentUnits),["c"]);
});

test("feature registration, duplicate chunk copies and enabled drift enforcement", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),"authored-visibility-"));
  try {
    const config = path.join(temp,"features.json");
    const assets = path.join(temp,"webview","assets");
    fs.mkdirSync(assets,{recursive:true});
    const options = {featuresRoot:path.join(__dirname,".."),featuresConfigPath:config};
    fs.writeFileSync(config,JSON.stringify({enabled:[]}));
    assert.deepEqual(loadLinuxFeaturePatchDescriptors(options),[]);
    fs.writeFileSync(config,JSON.stringify({enabled:["authored-message-visibility"]}));
    const loaded = loadLinuxFeaturePatchDescriptors(options);
    assert.equal(loaded.length,1);
    const file = path.join(assets,"async","366297.f0d89078fe.js");
    for (const scenario of ["valid","already","missing","drift","duplicated","mixed"]) {
      fs.rmSync(assets,{recursive:true,force:true}); fs.mkdirSync(assets,{recursive:true});
      const source = scenario === "already" ? apply(fixture) : scenario === "drift" ? fixture.replace('"not-sent"===i.deliveryStatus','"queued"===i.deliveryStatus') : fixture;
      fs.mkdirSync(path.dirname(file),{recursive:true});
      if (scenario !== "missing") fs.writeFileSync(file,source);
      // rspack can copy one module into several async chunks: patch every copy,
      // and fail when any needle-matching chunk lacks the complete contract.
      const other = path.join(assets,"async","918273.0a1b2c3d4e.js");
      if (["duplicated","mixed"].includes(scenario)) {
        fs.mkdirSync(path.dirname(other),{recursive:true});
        fs.writeFileSync(other,scenario === "mixed" ? "persistentUnits:collapsibleUnits:keepMcpAppEntriesPersistent:" : source);
      }
      const report = createPatchReport(); report.enabledFeatures=["authored-message-visibility"];
      captureWarnings(() => applyWebviewAssetPatchDescriptors(temp,loaded,{},report));
      if (["valid","already","duplicated"].includes(scenario)) {
        assert.equal(enabledFeatureFailuresFromReport(report).length,0);
        assert.equal(fs.readFileSync(file,"utf8"),apply(fixture));
        if (scenario === "duplicated") assert.equal(fs.readFileSync(other,"utf8"),apply(fixture));
        const repeated=createPatchReport();repeated.enabledFeatures=["authored-message-visibility"];
        captureWarnings(()=>applyWebviewAssetPatchDescriptors(temp,loaded,{},repeated));
        assert.equal(repeated.patches[0].status,"already-applied");
        assert.equal(enabledFeatureFailuresFromReport(repeated).length,0);
      } else {
        assert.equal(enabledFeatureFailuresFromReport(report).length,1);
        if (!["missing","mixed"].includes(scenario)) assert.equal(fs.readFileSync(file,"utf8"),source);
      }
    }
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview has one complete classifier that patches to valid JavaScript", { skip: !signedApp }, () => {
  const { patchBreaksJavaScriptSyntax } = require("../../scripts/patches/lib/javascript-syntax.js");
  const names = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles);
  assert.ok(names.length >= 1);
  let fixtureSeen = false;
  for (const name of names) {
    const source = fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8");
    fixtureSeen ||= source.includes(fixture.slice("const xO=".length,-1));
    const result = captureWarnings(() => apply(source));
    assert.deepEqual(result.warnings, [], name);
    assert.notEqual(result.value, source, name);
    assert.equal(apply(result.value), result.value, name);
    assert.equal(patchBreaksJavaScriptSyntax(source, result.value), false, name);
    assert.ok(javascriptSourceParses(result.value),name);
  }
  assert.ok(fixtureSeen,"behavior fixture must be the actual current partition");
});
