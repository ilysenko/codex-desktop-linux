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

// Current signed rspack/SWC partition with the inlined classifier, anchored by
// semantics rather than the chunk filename or minified aliases.
const fixture = 'function xO(e,{hasFollowingFinalAnswer:t=!1,isTurnInProgress:turn=!1,keepMcpAppEntriesPersistent:s=!1,mcpServerStatuses:a,plainAsyncMessageIds:plain,renderMcpApps:i=!1}={}){let r=[],o=[],l=[],c=[],d=null;for(let m of e){l.push(m),function({unit:e,hasFollowingFinalAnswer:t,keepMcpAppEntriesPersistent:n,mcpServerStatuses:s,plainAsyncMessageIds:a,renderMcpApps:r}){if("standalone"!==e.kind)return!1;let i=e.item.item;return"user-input-response"===i.type?!i.completed:!!("mcp-tool-call"===i.type&&(0,g.o)(i))||("assistant-message"===i.type?(0,p.Yr)(i)||"async"===i.delivery&&null!=i.searchItemId&&a?.has(i.searchItemId)===!0:!!("dynamic-tool-call"===i.type&&(0,h.Q1)(i)||n&&r&&"mcp-tool-call"===i.type&&function({item:e,mcpServerStatuses:t}){return e.interactive}({item:i,mcpServerStatuses:s}))||"user-message"===i.type&&("pending"===i.steeringStatus||!0===i.followsInterruptedFinalAnswer||!0===i.wasInHistoryPreview||"not-sent"===i.deliveryStatus||!0===i.hookFeedback||!t))}({unit:m,hasFollowingFinalAnswer:t,keepMcpAppEntriesPersistent:s,mcpServerStatuses:a,plainAsyncMessageIds:plain,renderMcpApps:i})?r.push(m):o.push(m)}return{collapsibleUnits:o,expandedUnits:l,persistentUnits:r,preToggleUnits:c,workedForItem:d}}';
function partition(source, units, options) {
  return vm.runInNewContext(source + ";xO", { g: { o: item => item.persist }, p: { Yr: item => item.final }, h: { Q1: item => item.interactive } })(units, options);
}
const unit = (type, id, extra = {}) => ({kind:"standalone",item:{item:{type,id,...extra}}});
const ids = units => Array.from(units, unit => unit.item.item.id);

test("commentary stays visible in order while tools collapse; expansion contains each item once", () => {
  const units = [unit("assistant-message","c1"),unit("exec","tool"),unit("user-message","steering",{steeringStatus:"accepted"}),unit("assistant-message","c2"),unit("user-message","ordinary"),unit("user-message","interrupted",{followsInterruptedFinalAnswer:true}),unit("user-message","hook",{hookFeedback:true})];
  assert.deepEqual(ids(partition(fixture,units,{hasFollowingFinalAnswer:true}).persistentUnits), ["interrupted","hook"]);
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  for (let toggle = 0; toggle < 3; toggle++) {
    const result = partition(patched, units);
    assert.deepEqual(ids(result.persistentUnits), ["c1","steering","c2","ordinary","interrupted","hook"]);
    assert.deepEqual(ids(result.collapsibleUnits), ["tool"]);
    assert.deepEqual(ids(result.expandedUnits), ids(units));
  }
  assert.equal(apply(patched), patched);
});

test("tool exceptions, grouped activity and worked-for handling remain upstream-owned", () => {
  const tools = [unit("exec","exec"),unit("dynamic-tool-call","dynamic",{interactive:true}),unit("mcp-tool-call","mcp",{interactive:true}),unit("worked-for","duration")];
  const options = {hasFollowingFinalAnswer:true,keepMcpAppEntriesPersistent:true,renderMcpApps:true};
  assert.equal(JSON.stringify(partition(apply(fixture),tools,options)),JSON.stringify(partition(fixture,tools,options)));
  const group = {kind:"group",items:[]};
  assert.equal(partition(apply(fixture),[group]).collapsibleUnits[0],group);
});

test("missing, duplicate, mixed and changed classifiers remain byte-identical with actionable warnings", () => {
  const patched = apply(fixture);
  for (const source of ["",fixture+fixture,patched+patched,fixture+patched,fixture.replace('"not-sent"===i.deliveryStatus','"queued"===i.deliveryStatus'),fixture.replace("i=e.item.item","i=e.item.other")]) {
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value,source);
    assert.equal(result.warnings.length,1);
    assert.match(result.warnings[0],/Disable authored-message-visibility and rebuild/);
  }
});

test("classifier aliases can change without changing behavior", () => {
  const source = fixture.replace(/\bi\b/g,"itemAlias");
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
      } else {
        assert.equal(enabledFeatureFailuresFromReport(report).length,1);
        if (!["missing","mixed"].includes(scenario)) assert.equal(fs.readFileSync(file,"utf8"),source);
      }
    }
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official signed webview has one complete classifier that patches to valid JavaScript", { skip: !signedApp }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const { patchBreaksJavaScriptSyntax } = require("../../scripts/patches/lib/javascript-syntax.js");
  const names = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles);
  assert.ok(names.length >= 1);
  for (const name of names) {
    const source = fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8");
    const result = captureWarnings(() => apply(source));
    assert.deepEqual(result.warnings, [], name);
    assert.notEqual(result.value, source, name);
    assert.equal(apply(result.value), result.value, name);
    assert.equal(patchBreaksJavaScriptSyntax(source, result.value), false, name);
  }
});
