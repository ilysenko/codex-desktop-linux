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

// Verbatim partition and classifier from signed official Linux 26.908.40834.
const fixture = "function kG(e,{keepMcpAppEntriesPersistent:t=!1,mcpServerStatuses:n,renderMcpApps:r=!1}={}){let i=[],a=[],o=[],s=[],c=null;for(let l of e){if(l.kind===`standalone`&&l.item.item.type===`worked-for`){c=l.item.item;continue}if(l.kind===`standalone`&&l.item.item.type===`realtime-transcript`){a.length===0?s.push(l):(a.push(l),o.push(l));continue}a.push(l),AG({unit:l,keepMcpAppEntriesPersistent:t,mcpServerStatuses:n,renderMcpApps:r})?o.push(l):i.push(l)}return{collapsibleUnits:i,expandedUnits:a,persistentUnits:o,preToggleUnits:s,workedForItem:c}}function AG({unit:e,keepMcpAppEntriesPersistent:t,mcpServerStatuses:n,renderMcpApps:r}){if(e.kind!==`standalone`)return!1;let i=e.item.item;return i.type===`dynamic-tool-call`&&Mh(i)||t&&r&&i.type===`mcp-tool-call`&&jG({item:i,mcpServerStatuses:n})?!0:i.type===`user-message`&&(i.steeringStatus!=null||i.hookFeedback===!0)}";
function partition(source, units, options) {
  return vm.runInNewContext(source + ";kG", { Mh: item => item.interactive, jG: ({item}) => item.interactive })(units, options);
}
const unit = (type, id, extra = {}) => ({kind:"standalone",item:{item:{type,id,...extra}}});
const ids = units => Array.from(units, unit => unit.item.item.id);

test("commentary stays visible in order while tools collapse; expansion contains each item once", () => {
  const units = [unit("assistant-message","c1"),unit("exec","tool"),unit("user-message","steering",{steeringStatus:"accepted"}),unit("assistant-message","c2"),unit("user-message","ordinary"),unit("user-message","hook",{hookFeedback:true})];
  assert.deepEqual(ids(partition(fixture,units).persistentUnits), ["steering","hook"]);
  const patched = apply(fixture);
  assert.notEqual(patched, fixture);
  for (let toggle = 0; toggle < 3; toggle++) {
    const result = partition(patched, units);
    assert.deepEqual(ids(result.persistentUnits), ["c1","steering","c2","ordinary","hook"]);
    assert.deepEqual(ids(result.collapsibleUnits), ["tool"]);
    assert.deepEqual(ids(result.expandedUnits), ids(units));
  }
  assert.equal(apply(patched), patched);
});

test("tool exceptions, grouped activity and worked-for handling remain upstream-owned", () => {
  const tools = [unit("exec","exec"),unit("dynamic-tool-call","dynamic",{interactive:true}),unit("mcp-tool-call","mcp",{interactive:true}),unit("worked-for","duration")];
  const options = {keepMcpAppEntriesPersistent:true,renderMcpApps:true};
  assert.equal(JSON.stringify(partition(apply(fixture),tools,options)),JSON.stringify(partition(fixture,tools,options)));
  const group = {kind:"group",items:[]};
  assert.equal(partition(apply(fixture),[group]).collapsibleUnits[0],group);
});

test("missing, duplicate, mixed and changed classifiers remain byte-identical with actionable warnings", () => {
  const patched = apply(fixture);
  for (const source of ["",fixture+fixture,patched+patched,fixture+patched,fixture.replace("hookFeedback===!0","hookFeedback===!1"),fixture.replace("i=e.item.item","i=e.item.other")]) {
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

test("feature registration, unique asset selection and enabled drift enforcement", () => {
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
    const file = path.join(assets,"conversation-blocks-newHash.js");
    for (const scenario of ["valid","already","missing","drift","ambiguous"]) {
      for (const name of fs.readdirSync(assets)) fs.unlinkSync(path.join(assets,name));
      const source = scenario === "already" ? apply(fixture) : scenario === "drift" ? fixture.replace("hookFeedback===!0","hookFeedback===!1") : fixture;
      if (scenario !== "missing") fs.writeFileSync(file,source);
      if (scenario === "ambiguous") fs.writeFileSync(path.join(assets,"conversation-blocks-other.js"),source);
      const report = createPatchReport(); report.enabledFeatures=["authored-message-visibility"];
      captureWarnings(() => applyWebviewAssetPatchDescriptors(temp,loaded,{},report));
      if (["valid","already"].includes(scenario)) {
        assert.equal(enabledFeatureFailuresFromReport(report).length,0);
        assert.equal(fs.readFileSync(file,"utf8"),apply(fixture));
      } else {
        assert.equal(enabledFeatureFailuresFromReport(report).length,1);
        if (scenario !== "missing") assert.equal(fs.readFileSync(file,"utf8"),source);
      }
    }
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
