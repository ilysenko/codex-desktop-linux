"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { applyAuthoredMessageVisibilityPatch: apply, descriptors } = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

// Current signed-package partition and classifier, anchored by semantics rather
// than the bundle filename or minified aliases.
const fixture = fs.readFileSync(path.join(__dirname, "../../scripts/patches/lib/fixtures/current-activity-partition.js"), "utf8").replace("const partition=", "const xO=").trim();
function partition(source, units, options, reasoningEnabled = false) {
  return vm.runInNewContext(source + ";xO", {
    f: { o: item => item.persist },
    m: { Yr: item => item.final, rt: item => item.final },
    p: { Q1: item => item.interactive },
    h: { i$: ({ toolResult }) => toolResult?.interactive ? {} : null },
    localStorage: { getItem: () => reasoningEnabled ? "1" : null },
  })(units, options);
}
const unit = (type, id, extra = {}) => ({kind:"standalone",item:{item:{type,id,completed:true,invocation:{server:"test",tool:"tool"},result:{type:"success",raw:{interactive:extra.interactive}},...extra}}});
const chunk = source => `export const __rspack_esm_ids=[101];export const __webpack_modules__={QypQ(e,t,n){${source}}};`;
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
  const partialAssistant = fixture.replace('"assistant-message"===l.type?(0,m.Yr)(l)', '"assistant-message"===l.type?!0');
  const partialUser = patched.replace('"assistant-message"===l.type||', '"assistant-message"===l.type&&(0,m.Yr)(l)||');
  const retiredShape = fixture.replace('if("standalone"!==e.kind)', 'if(e.kind!==`standalone`)');
  for (const source of ["",fixture+fixture,patched+patched,fixture+patched,partialAssistant,partialUser,retiredShape,
    fixture.replace('"not-sent"===l.deliveryStatus','"queued"===l.deliveryStatus'),fixture.replace("l=e.item.item","l=e.item.other"),
    fixture.replace("toolResult:n", "toolResult:unknown"),
    fixture.replace("mcpServerStatuses:t,server:e.invocation.server", "mcpServerStatuses:unknown,server:e.invocation.server"),
    fixture.replace("server:e.invocation.server", "server:unknown.invocation.server"),
    fixture.replace("e.result.raw:null", "unknown.result.raw:null"),
    fixture.replace("item:l,mcpServerStatuses:a", "item:unknown,mcpServerStatuses:a")]) {
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value,source);
    assert.equal(result.warnings.length,1);
    assert.match(result.warnings[0],/Disable authored-message-visibility and rebuild/);
  }
});

test("a valid classifier never hides a second drifted or partially applied classifier", () => {
  for (const drifted of [
    fixture.replace('"not-sent"===l.deliveryStatus','"queued"===l.deliveryStatus'),
    fixture.replace("toolResult:n","toolResult:unknown"),
    apply(fixture).replace('"assistant-message"===l.type||','"assistant-message"===l.type&&(0,m.Yr)(l)||'),
  ]) {
    const source=`export const __webpack_modules__={Good(e){${fixture}},Drifted(e){${drifted}}};`;
    assert.ok(javascriptSourceParses(source));
    const result=captureWarnings(()=>apply(source));
    assert.equal(result.value,source);assert.equal(result.warnings.length,1);
    assert.match(result.warnings[0],/of 2/);
  }
});

test("authored visibility keeps the existing reasoning prefix in both application orders", () => {
  const reasoning = { apply: require("../reasoning-visibility/persistent.js").applyPersistentPatch };
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
  const source = fixture.replace(/(?<![\w$])l(?![\w$])/g,"itemAlias");
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
      const source = scenario === "already" ? apply(fixture) : scenario === "drift" ? fixture.replace('"not-sent"===l.deliveryStatus','"queued"===l.deliveryStatus') : fixture;
      fs.mkdirSync(path.dirname(file),{recursive:true});
      if (scenario !== "missing") fs.writeFileSync(file,chunk(source));
      // rspack can copy one module into several async chunks: patch every copy,
      // and fail when any needle-matching chunk lacks the complete contract.
      const other = path.join(assets,"async","918273.0a1b2c3d4e.js");
      if (["duplicated","mixed"].includes(scenario)) {
        fs.mkdirSync(path.dirname(other),{recursive:true});
        fs.writeFileSync(other,chunk(scenario === "mixed" ? 'const damaged="persistentUnits:collapsibleUnits:keepMcpAppEntriesPersistent:";' : source));
      }
      const report = createPatchReport(); report.enabledFeatures=["authored-message-visibility"];
      captureWarnings(() => applyExtractedAppPatchDescriptors(temp,loaded,{},report,"extracted-app:pre-webview"));
      if (["valid","already","duplicated"].includes(scenario)) {
        assert.equal(enabledFeatureFailuresFromReport(report).length,0);
        assert.equal(fs.readFileSync(file,"utf8"),chunk(apply(fixture)));
        if (scenario === "duplicated") assert.equal(fs.readFileSync(other,"utf8"),chunk(apply(fixture)));
        const repeated=createPatchReport();repeated.enabledFeatures=["authored-message-visibility"];
        captureWarnings(()=>applyExtractedAppPatchDescriptors(temp,loaded,{},repeated,"extracted-app:pre-webview"));
        assert.equal(repeated.patches[0].status,"already-applied");
        assert.equal(enabledFeatureFailuresFromReport(repeated).length,0);
      } else {
        assert.equal(enabledFeatureFailuresFromReport(report).length,1);
        if (scenario !== "missing") assert.equal(fs.readFileSync(file,"utf8"),chunk(source));
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

function descriptorWorkspace(t, sources, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authored-cohort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: enabled ? ["authored-message-visibility"] : [] }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config });
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return { file, source };
  });
  const run = () => {
    const report = createPatchReport();
    report.enabledFeatures = enabled ? ["authored-message-visibility"] : [];
    captureWarnings(() => applyExtractedAppPatchDescriptors(root, loaded, {}, report, "extracted-app:pre-webview"));
    return report;
  };
  return { files, loaded, run };
}

test("current native async delivery expression remains verbatim behind authored overrides", () => {
  const start = fixture.indexOf('return"user-input-response"') + "return".length;
  const end = fixture.indexOf("}({unit:x", start);
  const native = fixture.slice(start, end);
  const patched = apply(fixture);
  assert.ok(patched.includes(native));
  for (const plainAsyncMessageIds of [undefined, new Set(), new Set(["ticket"])]) {
    const items = [unit("assistant-message", "async", { delivery: "async", searchItemId: "ticket" }),
      unit("assistant-message", "other", { delivery: "async", searchItemId: "other" }), unit("exec", "tool")];
    const options = { hasFollowingFinalAnswer: true, plainAsyncMessageIds };
    const baseline = ids(partition(fixture, items, options).persistentUnits);
    assert.deepEqual(baseline, plainAsyncMessageIds?.has("ticket") ? ["async"] : []);
    assert.deepEqual(ids(partition(patched, items, options).persistentUnits), ["async", "other"]);
  }
});

test("current classifier refuses missing or disconnected async Set and caller bindings", () => {
  for (const source of [
    fixture.replace("plainAsyncMessageIds:s,renderMcpApps:i", "renderMcpApps:i"),
    fixture.replace("s?.has(l.searchItemId)", "wrong?.has(l.searchItemId)"),
    fixture.replace("plainAsyncMessageIds:i,renderMcpApps:l})", "plainAsyncMessageIds:wrong,renderMcpApps:l})"),
    fixture.replace("mcpServerStatuses:s,plainAsyncMessageIds:i,renderMcpApps:l=!1", "mcpServerStatuses:s,plainAsyncMessageIds:wrong,renderMcpApps:l=!1"),
  ]) {
    assert.notEqual(source, fixture);
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
  }
});

test("normal descriptor validates every same-identity copy and rejects partial application atomically", t => {
  for (const other of [
    chunk(fixture.replace("s?.has(l.searchItemId)", "wrong?.has(l.searchItemId)")),
    chunk(apply(fixture)),
    chunk(fixture).replace("QypQ(e,t,n)", "Other(e,t,n)"),
  ]) {
    const project = descriptorWorkspace(t, { "async/a.js": chunk(fixture), "async/b.js": other });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    for (const { file, source } of project.files) assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("normal descriptor rolls back a later truncated copy write", t => {
  const project = descriptorWorkspace(t, { "async/a.js": chunk(fixture), "async/b.js": chunk(fixture) });
  const originalWrite = fs.writeFileSync;
  let failed = false;
  t.mock.method(fs, "writeFileSync", (file, bytes, ...args) => {
    if (file === project.files[1].file && !failed) {
      failed = true;
      originalWrite(file, "truncated");
      throw new Error("injected later copy write failure");
    }
    return originalWrite(file, bytes, ...args);
  });
  assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
  assert.equal(failed, true);
  for (const { file, source } of project.files) assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("disabled feature loads no descriptor and performs no asset discovery", t => {
  const project = descriptorWorkspace(t, {}, false);
  assert.deepEqual(project.loaded, []);
  let discovered = false;
  t.mock.method(fs, "readdirSync", () => { discovered = true; throw new Error("unexpected discovery"); });
  assert.deepEqual(project.run().patches, []);
  assert.equal(discovered, false);
});

test("latest signed owner applies through the registered transactional descriptor", { skip: !signedApp }, t => {
  const names = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles);
  assert.equal(names.length, 1);
  const source = fs.readFileSync(path.join(signedApp, "webview", "assets", names[0]), "utf8");
  const project = descriptorWorkspace(t, { [names[0]]: source });
  assert.equal(project.run().patches[0].status, "applied");
  assert.equal(project.run().patches[0].status, "already-applied");
  for (const header of ["async function({unit:", "async/*gap*/function({unit:", "async\tfunction({unit:",
    "async function\n({unit:", "function*({unit:", "async function*({unit:"]) {
    const mutant = source.replace("function({unit:", header);
    assert.ok(javascriptSourceParses(mutant));
    assert.equal(captureWarnings(() => apply(mutant)).value, mutant);
    const invalid = descriptorWorkspace(t, { [names[0]]: mutant });
    assert.equal(enabledFeatureFailuresFromReport(invalid.run()).length, 1);
    assert.equal(fs.readFileSync(invalid.files[0].file, "utf8"), mutant);
  }
  const nativeOwner = require("../../scripts/patches/lib/activity-partition.js").inspectActivityPartition(source);
  const renamed = source.replaceAll("collapsibleUnits:", "missingCollapsible:").replaceAll("persistentUnits:", "missingPersistent:");
  const resultOnly = source.slice(0, nativeOwner.result.start) + nativeOwner.result.source
    .replace("collapsibleUnits:", "missingCollapsible:").replace("persistentUnits:", "missingPersistent:") + source.slice(nativeOwner.result.end);
  const decoy = resultOnly.slice(0, nativeOwner.loop.start) + 'const note="collapsibleUnits:persistentUnits:";' + resultOnly.slice(nativeOwner.loop.start);
  for (const mutant of [renamed, renamed.replaceAll("keepMcpAppEntriesPersistent:", "missingKeepMcp:"), decoy]) {
    assert.ok(javascriptSourceParses(mutant));
    const invalid = descriptorWorkspace(t, { "async/good.js": source, "async/hidden.js": mutant });
    assert.equal(enabledFeatureFailuresFromReport(invalid.run()).length, 1);
    for (const { file, source: before } of invalid.files) assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  assert.equal(fs.readFileSync(path.join(signedApp, "webview", "assets", names[0]), "utf8"), source);
});

test("non-current activity callable kinds are rejected before normal cohort writes", t => {
  for (const header of ["async function({unit:", "async/*gap*/function({unit:", "async\tfunction({unit:",
    "async function\n({unit:", "function*({unit:", "async function*({unit:", "new function({unit:"]) {
    const source = fixture.replace("function({unit:", header);
    assert.doesNotThrow(() => new vm.Script(source));
    assert.equal(captureWarnings(() => apply(source)).value, source);
    const project = descriptorWorkspace(t, { "async/current.js": chunk(source) });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    assert.equal(fs.readFileSync(project.files[0].file, "utf8"), chunk(source));
  }
});

test("authored cohort refuses same-ID copies whose native result loses every discovery needle", t => {
  const missing = fixture.replace("collapsibleUnits:", "missingCollapsible:").replace("persistentUnits:", "missingPersistent:");
  const owner = require("../../scripts/patches/lib/activity-partition.js").inspectActivityPartition(fixture);
  const decoy = missing.slice(0, owner.loop.start) + 'const note="collapsibleUnits:persistentUnits:";' + missing.slice(owner.loop.start);
  for (const source of [missing, decoy]) {
    const project = descriptorWorkspace(t, { "async/good.js": chunk(fixture), "async/bad.js": chunk(source) });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    for (const { file, source: original } of project.files) assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});
