"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { inspectGlobalShortcutsPortal, installPortalBackend, PATCH_MARKER } = require("./global-shortcuts-portal.js");
const { mainBundleFixture } = require("./global-shortcuts-portal.test-helpers.js");
const { applyLinuxGlobalDictationMainProcessPatch: dictation } = require("../../../linux-features/global-dictation/patch.js");
const { applyWaylandGlobalShortcutsPatch: shortcuts } = require("../../../linux-features/wayland-global-shortcuts/patch.js");

function assertActualRanges(source, metadata, shared) {
  assert.equal(metadata.reason, null); assert.ok(metadata.owner);
  const owner = metadata.owner, factory = source.slice(owner.factoryBody.start, owner.factoryBody.end);
  const producer = source.slice(owner.windowServices.body.start, owner.windowServices.body.end);
  assert.ok(factory.includes(metadata.owner.registration.body));
  assert.equal(source.slice(owner.registration.start, owner.registration.end), owner.registration.body);
  assert.ok(owner.factoryBody.start < owner.windowServices.body.start && owner.windowServices.body.end < owner.factoryBody.end);
  assert.equal(producer.includes(",codexLinuxGlobalShortcutsPortalShutdown(),"), shared);
  for (const [key, binding] of Object.entries(owner.windowServices.bindings)) assert.ok(producer.includes(`${key}:${binding}`), key);
  assert.equal(source[owner.factoryBody.end], "}"); assert.equal(source[owner.windowServices.body.end], "}");
  assert.deepEqual(Object.keys(owner).sort(), ["factoryBody", "id", "registration", "windowServices"]);
}

for (const key of ["82820", '"82820"', "8.282e4", "0x14384"]) {
  test(`Portal semantic facade normalizes owner identity ${key}`, () => {
    const source = mainBundleFixture({ key }), metadata = inspectGlobalShortcutsPortal(source);
    assert.equal(metadata.state, "current"); assert.deepEqual(metadata.factoryIds, ["82820"]); assert.equal(metadata.owner.id, "82820");
    assertActualRanges(source, metadata, false);
    assert.deepEqual(metadata.owner.windowServices.bindings, {
      windowManager: "D", avatarOverlayManager: "M", notchOverlayManager: "O", spotlightController: "U",
      hotkeyWindowLifecycleManager: "j", globalDictationLifecycleManager: "L",
      appshotHotkeysService: "A", overlayHotkeyController: "Q", realtimeVoiceHotkeyController: "V",
    });
  });
}

test("Portal semantic facade returns actual supplied coordinates in either shared order", () => {
  const source = mainBundleFixture();
  for (const installed of [installPortalBackend(source), shortcuts(dictation(source)), dictation(shortcuts(source))]) {
    const metadata = inspectGlobalShortcutsPortal(installed);
    assert.equal(metadata.state, "shared"); assertActualRanges(installed, metadata, true);
    assert.ok(metadata.owner.registration.start > inspectGlobalShortcutsPortal(source).owner.registration.start);
  }
});

test("Portal semantic facade projects other bound returned data roles without constructor inference", () => {
  const original = mainBundleFixture();
  const declared = original.replace(";return{windowManager:D", ";const Extra={};return{windowManager:D");
  assert.notEqual(declared, original, "The additional role is declared in the current window producer");
  const source = declared.replace("spotlightController:U,hotkeyWindowLifecycleManager:j,globalDictationLifecycleManager:L,markAppQuitting:", "spotlightController:U,additionalService:Extra,hotkeyWindowLifecycleManager:j,globalDictationLifecycleManager:L,markAppQuitting:");
  assert.notEqual(source, declared, "The declared role is added to the returned window object");
  const metadata = inspectGlobalShortcutsPortal(source);
  assert.equal(metadata.state, "current"); assert.equal(metadata.owner.windowServices.bindings.additionalService, "Extra");
  assert.equal(metadata.owner.windowServices.bindings.markAppQuitting, undefined);
});

test("Portal semantic facade retains opaque factory IDs without inventing an owner", () => {
  for (const key of ["82820", '"82820"', "8.282e4", "0x14384"]) {
    const metadata = inspectGlobalShortcutsPortal(`exports.ids=[46],exports.modules={${key}(e,t,r){return false}};`);
    assert.equal(metadata.state, "unrelated"); assert.deepEqual(metadata.factoryIds, ["82820"]); assert.equal(metadata.owner, null); assert.ok(metadata.reason);
  }
  const malformed = inspectGlobalShortcutsPortal("exports.ids=[46],exports.modules={82820(e,t,r){");
  assert.equal(malformed.state, "drifted"); assert.ok(malformed.reason);
  for (const source of ["const broken=;exports.ids=[46],exports.modules={82820(){return false}};", "ordinary syntax error )"]) {
    const invalid = inspectGlobalShortcutsPortal(source);
    assert.equal(invalid.state, "drifted"); assert.equal(invalid.owner, null); assert.ok(invalid.reason);
  }
  const duplicate = inspectGlobalShortcutsPortal('exports.ids=[46],exports.modules={82820(){},"82820"(){}};');
  assert.equal(duplicate.state, "drifted"); assert.match(duplicate.reason, /Duplicate/u);
  for (const source of [
    'exports.ids=[46];exports.modules={"82820"(){return false}};',
    'exports.modules={"82820"(){return false}};',
    'exports["modules"]={"82820"(){return false}};',
  ]) {
    const unsupported = inspectGlobalShortcutsPortal(source);
    assert.equal(unsupported.state, "drifted"); assert.equal(unsupported.owner, null); assert.ok(unsupported.reason);
  }
});

test("Portal semantic facade refuses partial shared authority and marks unrelated input", () => {
  const shared = installPortalBackend(mainBundleFixture());
  const partial = inspectGlobalShortcutsPortal(shared.replace(",codexLinuxGlobalShortcutsPortalShutdown(),", ","));
  assert.equal(partial.state, "drifted"); assert.deepEqual(partial.factoryIds, ["82820"]); assert.equal(partial.owner, null); assert.ok(partial.reason);
  assert.equal(inspectGlobalShortcutsPortal(`const marker=${JSON.stringify(PATCH_MARKER)};`).state, "drifted");
  assert.equal(inspectGlobalShortcutsPortal('const entry="ordinary runtime";').state, "unrelated");
  assert.equal(inspectGlobalShortcutsPortal('const note="exports.modules={}";/* exports.ids=[46]; */').state, "unrelated");
  assert.equal(inspectGlobalShortcutsPortal(null).state, "drifted");
});

for (const variable of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  const signed = process.env[variable];
  test(`Portal facade projects current signed raw/shared owner and unrelated entry (${variable})`, { skip: !signed }, () => {
    const build = path.join(signed, ".vite/build");
    const originals = fs.readdirSync(build).filter(name => /^early-bootstrap.*\.js$/u.test(name))
      .map(name => ({ name, source: fs.readFileSync(path.join(build, name), "utf8") }));
    assert.equal(originals.length, 19);
    const owners = originals.map(row => ({ ...row, metadata: inspectGlobalShortcutsPortal(row.source) })).filter(row => row.metadata.owner);
    assert.equal(owners.length, 1); const owner = owners[0];
    assert.equal(inspectGlobalShortcutsPortal(originals.find(row => row.name === "early-bootstrap.js").source).state, "unrelated");
    assert.equal(owner.metadata.owner.id, "26307"); assert.equal(owner.metadata.state, "current");
    assertActualRanges(owner.source, owner.metadata, false);
    const unsupported = owner.source.replace(/exports\.ids=(\[[^\]]*\]),exports\.modules=/u, "exports.ids=$1;exports.modules=");
    assert.notEqual(unsupported, owner.source); assert.equal(inspectGlobalShortcutsPortal(unsupported).state, "drifted");
    const shared = installPortalBackend(owner.source), metadata = inspectGlobalShortcutsPortal(shared);
    assert.equal(metadata.state, "shared"); assertActualRanges(shared, metadata, true);
    assert.equal(installPortalBackend(shared), shared);
    assert.deepEqual(metadata.owner.windowServices.bindings, owner.metadata.owner.windowServices.bindings);
    for (const row of originals) assert.equal(fs.readFileSync(path.join(build, row.name), "utf8"), row.source);
  });
}
