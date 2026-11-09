"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mainBundlePatch } = require("./descriptor.js");
const { PatchIntegrityError } = require("./integrity-error.js");
const { applyMainProcessChunkPatchDescriptors, applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("./engine.js");
const { createPatchReport } = require("../lib/patch-report.js");
const { loadLinuxFeaturePatchDescriptors } = require("../lib/linux-features.js");
const { findMainProcessChunks } = require("./lib/assets.js");
const { mainBundleFixture } = require("./lib/global-shortcuts-portal.test-helpers.js");
const { inspectGlobalShortcutsPortal } = require("./lib/global-shortcuts-portal.js");

const noiseName = "early-bootstrap.js";
const ownerName = "early-bootstrap-650-123abc.js";
function chunks() { return [{ name: noiseName, source: "UNRELATED" }, { name: ownerName, source: "OWNER" }]; }
function quiet(run) {
  const old = console.warn, warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return { value: run(), warnings }; }
  finally { console.warn = old; }
}
function apply(input, descriptors, report = createPatchReport(), context = {}) {
  const result = quiet(() => applyMainProcessChunkPatchDescriptors(input, normalizePatchDescriptors(descriptors), context, report));
  return { ...result, report };
}

for (const other of ["changed", "quiet", "warning"]) for (const classified of [false, true]) {
  test(`main chunk ${other} result cannot hide ${classified ? "coded" : "class"} integrity failure`, () => {
    const error = classified ? Object.assign(new Error("owner rollback bytes could not be restored"), { code: "PATCH_INTEGRITY_FAILURE" }) : new PatchIntegrityError("owner rollback bytes could not be restored");
    const input = chunks(), before = structuredClone(input), report = createPatchReport();
    let later = 0, caught;
    const descriptors = [mainBundlePatch({ id: "optional-owner", ciPolicy: "optional", apply(source) {
      if (source === "OWNER") throw error;
      if (other === "warning") console.warn("WARN: unrelated anchor missing");
      return other === "changed" ? source + ";CHANGED" : source;
    } }), mainBundlePatch({ id: "after-integrity", apply(source) { later++; return source; } })];
    try { apply(input, descriptors, report); } catch (failure) { caught = failure; }
    assert.equal(caught, error);
    assert.equal(later, 0);
    assert.deepEqual(input, before);
    assert.equal(report.patches[0].status, "failed-integrity");
    assert.match(report.patches[0].reason, /rollback bytes could not be restored/);
    assert.deepEqual(report.patches[0].chunks, [ownerName]);
  });
}

test("an owner exception wins over an earlier unrelated warning and reports its chunk", () => {
  const descriptor = mainBundlePatch({ id: "owner-error", apply(source) {
    if (source !== "OWNER") { console.warn("WARN: unrelated anchor missing"); return source; }
    throw new Error("expected the native upload progress owner");
  } });
  const { report } = apply(chunks(), [descriptor]);
  assert.equal(report.patches[0].status, "skipped-optional");
  assert.match(report.patches[0].reason, /expected the native upload progress owner/);
  assert.doesNotMatch(report.patches[0].reason, /unrelated anchor missing/);
  assert.deepEqual(report.patches[0].chunks, [ownerName]);
});

test("scoped main candidates keep apply and canonical ownership metadata", () => {
  const descriptor = mainBundlePatch({ id: "scoped", assetMatch: source => source === "OWNER" || source === "PATCHED",
    apply: source => source === "OWNER" ? "PATCHED" : source });
  const first = apply(chunks(), [descriptor]);
  assert.equal(first.report.patches[0].status, "applied");
  assert.deepEqual(first.report.patches[0].chunks, [ownerName]);
  assert.equal(first.value[0].source, "UNRELATED");
  const repeated = apply(first.value, [descriptor]);
  assert.equal(repeated.report.patches[0].status, "already-applied");
  assert.deepEqual(repeated.report.patches[0].chunks, [ownerName]);
  const absent = apply([{ name: noiseName, source: "UNRELATED" }], [descriptor]);
  assert.equal(absent.report.patches[0].status, "skipped-optional");
  assert.deepEqual(absent.report.patches[0].chunks, []);
});

test("legacy unscoped clean no-ops and all-warning misses retain their result policy", () => {
  const clean = apply(chunks(), [mainBundlePatch({ id: "legacy-clean", apply: source => source })]);
  assert.equal(clean.report.patches[0].status, "already-applied");
  const missing = apply(chunks(), [mainBundlePatch({ id: "legacy-missing", apply(source) { console.warn("WARN: old anchor missing"); return source; } })]);
  assert.equal(missing.report.patches[0].status, "skipped-optional");
  assert.match(missing.report.patches[0].reason, /^legacy-missing matched no main-process chunk: old anchor missing/);
});

test("feature loader preserves the main candidate predicate's source, name and feature context", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresRoot = path.join(root, "features"), feature = path.join(featuresRoot, "diagnostic-probe");
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, "README.md"), "Temporary feature fixture.\n");
  fs.writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "diagnostic-probe", title: "Diagnostic probe", description: "Scoped main descriptor fixture", defaultEnabled: false, entrypoints: { patchDescriptors: "./patch.js" } }));
  fs.writeFileSync(path.join(feature, "patch.js"), `module.exports=[{id:"owner",phase:"main-bundle",assetMatch(source,name,context){if(context.feature.id!=="diagnostic-probe"||context.feature.settings.token!=="feature-context"||!name.startsWith("early-bootstrap"))throw Error("feature candidate context was lost");context.observed.push({source,name,token:context.feature.settings.token});return source.includes("OWNER")||source.includes("PATCHED")},apply(source,context){return source.replace("OWNER","PATCHED:"+context.feature.settings.token)}}];`);
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["diagnostic-probe"], settings: { "diagnostic-probe": { token: "feature-context" } } }));
  const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot, featuresConfigPath: config, strictConfig: true });
  const observed = [];
  const result = apply(chunks(), descriptors, createPatchReport(), { observed });
  assert.deepEqual(observed.map(item => item.name), [noiseName, ownerName]);
  assert.deepEqual(observed.map(item => item.token), ["feature-context", "feature-context"]);
  assert.equal(result.report.patches[0].status, "applied");
  assert.deepEqual(result.report.patches[0].chunks, [ownerName]);
  assert.equal(result.value[0].source, "UNRELATED");
  assert.equal(result.value[1].source, "PATCHED:feature-context");
});

for (const feature of ["global-dictation", "wayland-global-shortcuts"]) {
  test(`${feature} reports its native accepted-quit error through its extracted-app production entry`, t => {
    const source = mainBundleFixture();
    const mutant = source.replace("Promise.allSettled([l.flush(),c.flush(),u(),h()])", "Promise.allSettled([l.flush(),u(),h()])");
    assert.notEqual(mutant, source);
    const metadata = inspectGlobalShortcutsPortal(mutant);
    assert.equal(metadata.state, "drifted");
    assert.match(metadata.reason, /accepted-quit drain branches/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-owner-diagnostic-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, ".vite/build");
    fs.mkdirSync(directory, { recursive: true });
    const files = { "early-bootstrap.js": "const unrelated=true;", [ownerName]: mutant };
    for (let i = 0; i < 17; i++) files[`early-bootstrap-${1000 + i}-abc.js`] = `const unrelated${i}=true;`;
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes);
    const descriptor = require(`../../linux-features/${feature}/patch.js`).descriptors[0];
    assert.equal(descriptor.phase, "extracted-app:pre-webview");
    const report = createPatchReport();
    quiet(() => applyExtractedAppPatchDescriptors(root, normalizePatchDescriptors([descriptor]), {}, report, descriptor.phase));
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.ok(report.patches[0].reason.includes(metadata.reason), report.patches[0].reason);
    assert.ok(report.patches[0].reason.includes(ownerName), report.patches[0].reason);
    for (const [name, bytes] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), bytes);
  });
}

const signed = process.env.CODEX_SIGNED_EXTRACTED_APP;
const actualDescriptors = [require("../../linux-features/authenticated-proxy/patch.js").descriptors[0],
  ...require("../../linux-features/computer-use-linux/patch.js").filter(descriptor => descriptor.phase === "main-bundle")];
function nativeOwner(descriptor) {
  const inventory = findMainProcessChunks(signed);
  assert.ok(inventory);
  const changed = [];
  for (const name of inventory.chunks) {
    const file = path.join(inventory.buildDir, name), source = fs.readFileSync(file, "utf8");
    try { if (quiet(() => descriptor.apply(source, {})).value !== source) changed.push({ name, source, file }); }
    catch { /* An unrelated main chunk is allowed to miss the semantic owner. */ }
  }
  assert.equal(changed.length, 1, descriptor.id);
  return changed[0];
}
function replaceAt(source, at, before, after) { assert.ok(at >= 0); assert.ok(source.startsWith(before, at)); return source.slice(0, at) + after + source.slice(at + before.length); }
function ownerMutant(id, source) {
  if (id === "main-process-proxy-auth") {
    const fetch = source.indexOf("this.options.applicationNetwork.fetch(");
    const at = source.lastIndexOf('"same-origin"', fetch);
    assert.ok(fetch - at < 1000);
    return replaceAt(source, at, '"same-origin"', '"omit"');
  }
  if (id === "avatar-cursor") {
    const marker = source.indexOf("setRemoteHostedPIPContentComputerUseCursorLocationHandler");
    return replaceAt(source, source.lastIndexOf("=process.platform", marker), "=process.platform", "=unknownPlatform");
  }
  if (id === "ui-feature") {
    const at = source.indexOf("CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE");
    return replaceAt(source, source.indexOf("computerUse:!0", at), "computerUse:!0", "computerUse:!1");
  }
  const at = source.indexOf(".computerUse,autoInstallOptOutKey:");
  return replaceAt(source, source.indexOf('"darwin"===', at), '"darwin"===', '"plan9"===');
}
const ownerReasons = { "main-process-proxy-auth": /unique current app ready and applicationNetwork/, "avatar-cursor": /cursor registration function/, "ui-feature": /Computer Use desktop feature gate/, "plugin-gate": /expected one current native registration/ };
for (const descriptor of actualDescriptors) {
  test(`current signed ${descriptor.id} preserves owner diagnostics after an unrelated chunk`, { skip: !signed }, () => {
    const owner = nativeOwner(descriptor), mutant = ownerMutant(descriptor.id, owner.source);
    const inventory = findMainProcessChunks(signed);
    const unrelated = descriptor.id === "main-process-proxy-auth"
      ? { name: inventory.chunks.find(name => name.startsWith("early-bootstrap-339-")) }
      : { name: noiseName, source: "const unrelated=true;" };
    if (unrelated.source == null) unrelated.source = fs.readFileSync(path.join(inventory.buildDir, unrelated.name), "utf8");
    assert.equal(typeof descriptor.assetMatch, "function");
    assert.equal(descriptor.assetMatch(unrelated.source, unrelated.name, {}), false);
    assert.equal(descriptor.assetMatch(mutant, owner.name, {}), true);
    const input = [unrelated, { name: owner.name, source: mutant }];
    const before = structuredClone(input), result = apply(input, [descriptor]);
    assert.equal(result.report.patches[0].status, "skipped-optional");
    assert.match(result.report.patches[0].reason, ownerReasons[descriptor.id]);
    assert.deepEqual(result.report.patches[0].chunks, [owner.name]);
    assert.deepEqual(input, before);
    assert.equal(fs.readFileSync(owner.file, "utf8"), owner.source);
    const first = apply([unrelated, owner], [descriptor]);
    assert.equal(first.report.patches[0].status, "applied");
    const repeated = apply(first.value, [descriptor]);
    assert.equal(repeated.report.patches[0].status, "already-applied");
    assert.deepEqual(repeated.report.patches[0].chunks, [owner.name]);
  });
}
