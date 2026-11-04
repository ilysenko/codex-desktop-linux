"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  applyAutomationUpdateEagerToolPatch: apply,
  matchesAutomationUpdateEagerToolContract: matches,
  AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
} = require("./eager-update.js");
const descriptors = require("./patch.js").filter(({ id }) => id === "eager-automation-update");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");

// Current signed Rspack catalog body; aliases are independent of production matchers.
const fixture = 'function catalog(e,{eagerToolNames:t,deferredToolNames:n,supportsDynamicToolNamespaces:s}){return e.map(e=>({type:"function",...e,...s&&(!t.has(e.name)||n.includes(e.name))?{deferLoading:!0}:{}}))}';

test("only automation_update becomes eager and the other tool policy stays intact", () => {
  const patched = apply(fixture);
  const originalCatalog = vm.runInNewContext(fixture + ";catalog");
  const catalog = vm.runInNewContext(patched + ";catalog");
  const tools = [{name:"automation_update",parameters:{mode:"update"}}, {name:"allowed"}, {name:"deferred"}, {name:"other"}];
  for (const namespaces of [false, true]) {
    const options = {eagerToolNames:new Set(["allowed","deferred"]),deferredToolNames:["deferred"],supportsDynamicToolNamespaces:namespaces};
    const before = originalCatalog(tools, options);
    const after = catalog(tools, options);
    assert.equal(after[0].deferLoading, undefined);
    assert.equal(after[0].parameters, tools[0].parameters);
    assert.equal(JSON.stringify(after.slice(1)), JSON.stringify(before.slice(1)));
    assert.equal(after.length, tools.length);
  }
  assert.equal(apply(patched), patched);
});

test("missing, duplicate, mixed, partial and retired catalogs are rejected unchanged", () => {
  const patched = apply(fixture);
  for (const source of ["",fixture+fixture,patched+patched,fixture+patched,
    fixture.replace("n.includes(e.name)","n.includes(other.name)"),
    fixture.replaceAll('"function"','`function`'),
    patched.replace('e.name!=="automation_update"&&','wrong.name!=="automation_update"&&'),
    patched.replace('e.name!=="automation_update"&&','e.name!=="automation_update"||')]) {
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.equal(matches(source), false);
  }
});

test("only the mapped tool guard can prove an eager catalog is already applied", () => {
  const decoy = 'const unrelated=other.name!=="automation_update"&&enabled&&(!allowed.has(other.name)||deferred.includes(other.name));';
  const source = fixture + decoy;
  const patched = apply(source);
  assert.notEqual(patched, source);
  assert.ok(patched.endsWith(decoy));
  assert.equal(apply(patched), patched);
  assert.equal(matches(decoy), false);
  const wrong = apply(fixture).replace('e.name!=="automation_update"&&', 'wrong.name!=="automation_update"&&');
  const catalog = vm.runInNewContext(wrong + ";catalog", { wrong: { name: "other" } });
  const tools = catalog([{ name: "automation_update" }], {
    eagerToolNames: new Set(), deferredToolNames: [], supportsDynamicToolNamespaces: true,
  });
  assert.equal(tools[0].deferLoading, true);
  const rejected = captureWarnings(() => apply(wrong));
  assert.equal(rejected.value, wrong);
  assert.equal(rejected.warnings.length, 1);
  assert.equal(matches(wrong), false);
});

test("normal descriptor selects a nested owner and rejects ambiguous files atomically", t => {
  assert.deepEqual(descriptors[0].assetNeedles, AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES);
  assert.equal(descriptors[0].pattern, undefined);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),"eager-update-"));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const assets = path.join(directory,"webview","assets","async");
  fs.mkdirSync(assets,{recursive:true});
  const target = path.join(assets,"24191.hash.js");
  fs.writeFileSync(target, fixture);
  for (const expected of ["applied","already-applied"]) {
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(directory,descriptors,{},report);
    assert.equal(report.patches[0].status,expected);
    assert.equal(fs.readFileSync(target,"utf8"),apply(fixture));
  }
  fs.writeFileSync(path.join(assets,"another.js"),fixture);
  const report = createPatchReport();
  captureWarnings(() => applyWebviewAssetPatchDescriptors(directory,descriptors,{},report));
  assert.equal(report.patches[0].status,"skipped-optional");
  assert.equal(fs.readFileSync(target,"utf8"),apply(fixture));
  assert.equal(fs.readFileSync(path.join(assets,"another.js"),"utf8"),fixture);
});

test("normal descriptor rejects mixed, duplicate and wrong-tool states without writing", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eager-update-invalid-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assets = path.join(directory, "webview/assets/async");
  fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, "catalog.js");
  const patched = apply(fixture);
  for (const source of [
    fixture + fixture,
    fixture + patched,
    patched + patched,
    patched.replace('e.name!=="automation_update"&&', 'wrong.name!=="automation_update"&&'),
  ]) {
    fs.writeFileSync(target, source);
    const report = createPatchReport();
    captureWarnings(() => applyWebviewAssetPatchDescriptors(directory, descriptors, {}, report));
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.equal(fs.readFileSync(target, "utf8"), source);
  }
});

test("signed-current eager owner passes the indexed production descriptor twice", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const original = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const candidates = findWebviewAssetsContaining(original, AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES)
    .filter(name => matches(fs.readFileSync(path.join(original, "webview/assets", name), "utf8")));
  assert.equal(candidates.length, 1);
  const name = candidates[0];
  const source = fs.readFileSync(path.join(original, "webview/assets", name), "utf8");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eager-update-signed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "webview/assets", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  for (const expected of ["applied", "already-applied"]) {
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(directory, descriptors, {}, report);
    assert.equal(report.patches[0].status, expected);
  }
  assert.equal(fs.readFileSync(target, "utf8"), apply(source));
  assert.equal(fs.readFileSync(path.join(original, "webview/assets", name), "utf8"), source);
});
