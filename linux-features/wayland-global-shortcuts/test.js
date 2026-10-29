"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const { applyWaylandGlobalShortcutsPatch } = require("./patch.js");
const { mainBundleFixture, applyFeatures } = require("../../scripts/patches/lib/global-shortcuts-portal.test-helpers.js");
const { loadEnabledLinuxFeatures } = require("../../scripts/lib/linux-features.js");

for (const dictation of [false, true]) {
  for (const shortcuts of [false, true]) {
    test(`independent feature selection: dictation=${dictation}, shortcuts=${shortcuts}`, () => {
      const source = mainBundleFixture();
      const patched = applyFeatures(source, { dictation, shortcuts });
      assert.doesNotThrow(() => new vm.Script(patched));
      assert.equal(applyFeatures(patched, { dictation, shortcuts }), patched);
      const ids = Array.from(patched.matchAll(/linuxCommandId:"([^"]+)"/g), (m) => m[1]);
      assert.deepEqual(ids.filter((id) => id.startsWith("globalDictation")).sort(), dictation
        ? ["globalDictationHold", "globalDictationSingleTap"] : []);
      assert.deepEqual(ids.filter((id) => !id.startsWith("globalDictation")).sort(), shortcuts
        ? ["appshots", "hotkeyWindow", "meetings", "openAvatarOverlay", "realtimeVoice"] : []);
      assert.equal(patched.includes("codex-linux-global-dictation-v3"), dictation);
      assert.equal(patched.includes("codex-linux-wayland-global-shortcuts-v1"), shortcuts);
      assert.equal((patched.match(/codexLinuxGlobalShortcutsPortalQueue=Promise.resolve\(\)/g) ?? []).length, dictation || shortcuts ? 1 : 0);
      const enabled = loadEnabledLinuxFeatures({ featuresRoot: path.resolve(__dirname, ".."),
        enabledFeatureIds: [...(dictation ? ["global-dictation"] : []), ...(shortcuts ? ["wayland-global-shortcuts"] : [])] });
      assert.deepEqual(enabled.map(feature => feature.id).sort(),
        [...(dictation ? ["global-dictation"] : []), ...(shortcuts ? ["wayland-global-shortcuts"] : [])]);
    });
  }
}

test("app shortcut drift leaves its input unchanged", () => {
  const source = mainBundleFixture().replace("this.handleHotkeyWindowHotkeyPressed()", "this.unknownPopoutHandler()");
  assert.equal(applyFeatures(source, { dictation: false, shortcuts: true }), source);
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("signed main-process chunks route every app shortcut through one chunk", { skip: !signedApp }, () => {
  const directory = path.join(signedApp, ".vite/build");
  const changed = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const name of fs.readdirSync(directory).filter((file) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(file))) {
      const source = fs.readFileSync(path.join(directory, name), "utf8");
      const patched = applyWaylandGlobalShortcutsPatch(source);
      if (patched !== source) changed.push({ source, patched });
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(changed.length, 1);
  const [{ source, patched }] = changed;
  assert.equal(applyWaylandGlobalShortcutsPatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.deepEqual(Array.from(patched.matchAll(/linuxCommandId:"([^"]+)"/g), (m) => m[1]).sort(),
    ["appshots", "hotkeyWindow", "meetings", "openAvatarOverlay", "realtimeVoice"]);
  const both = applyFeatures(source, { dictation: true, shortcuts: true });
  assert.notEqual(both, source);
  assert.equal((both.match(/codexLinuxGlobalShortcutsPortalQueue=Promise.resolve\(\)/g) ?? []).length, 1);
});
