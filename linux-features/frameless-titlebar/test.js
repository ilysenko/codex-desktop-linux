#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarMenuPatch,
  applyFramelessTitlebarWebviewPatch,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
  assert.equal(patchFn(patched), patched);
  return patched;
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function copyFeatureTo(featuresRoot) {
  const featureDir = path.join(featuresRoot, "frameless-titlebar");
  fs.mkdirSync(featureDir, { recursive: true });
  for (const name of ["feature.json", "README.md", "patch.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(featureDir, name));
  }
}

test("frameless-titlebar stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frameless-titlebar-feature-"));
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    copyFeatureTo(featuresRoot);
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');

    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["frameless-titlebar"]}\n');
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      descriptors.map((descriptor) => descriptor.id).sort(),
      [
        "feature:frameless-titlebar:main-process",
        "feature:frameless-titlebar:webview-window-controls-layout",
      ],
    );
    const webviewPatch = descriptors.find(
      (descriptor) => descriptor.id === "feature:frameless-titlebar:webview-window-controls-layout",
    );
    assert.match("app-initial~app-main~onboarding-page-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("use-window-controls-safe-area-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("app-initial~app-main~onboarding-page~debug-window-page-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("app-main-abc.js", webviewPatch.pattern);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("frameless-titlebar removes Linux overlay controls and menu chrome", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "function codexLinuxTitleBarOverlay(e=1){return{color:a.nativeTheme.shouldUseDarkColors?`#111111`:o2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(30*e)}}",
    "case`primary`:return n===`darwin`?t?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r)}:n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay(r)}:{titleBarStyle:`default`};",
    "setWindowZoom(e,t){let n=r.BrowserWindow.fromWebContents(e);n==null||this.windowAppearances.get(n.id)!==`primary`||(process.platform===`darwin`?n.setWindowButtonPosition(f6(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(b2(t))))}",
    "installWindowsTitleBarOverlaySync(e,t){if((process.platform!==`win32`&&process.platform!==`linux`)||t!==`primary`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(this.windowZooms.get(e.id)):b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
    "process.platform===`linux`&&k.setMenuBarVisibility(!1),process.platform===`win32`&&k.removeMenu(),",
  ].join("");

  const patched = applyPatchTwice(applyFramelessTitlebarMainPatch, source);

  assert.match(patched, /n===`linux`\?\{titleBarStyle:`hidden`\}/);
  assert.match(
    patched,
    /process\.platform===`win32`&&\(this\.windowZooms\.set\(n\.id,t\),n\.setTitleBarOverlay\(b2\(t\)\)\)/,
  );
  assert.match(patched, /if\(process\.platform!==`win32`\|\|t!==`primary`\)return/);
  assert.match(
    patched,
    /process\.platform===`linux`&&k\.removeMenu\(\),process\.platform===`win32`&&k\.removeMenu\(\),/,
  );
  assert.doesNotMatch(patched, /setMenuBarVisibility/);
  assert.doesNotMatch(patched, /titleBarOverlay:codexLinuxTitleBarOverlay/);
  assert.doesNotMatch(patched, /process\.platform===`linux`[^;]*setTitleBarOverlay/);
  assert.doesNotMatch(patched, /process\.platform!==`linux`[^;]*setTitleBarOverlay/);
});

test("frameless-titlebar leaves core Linux removeMenu patch idempotent", () => {
  const source =
    "process.platform===`linux`&&k.removeMenu(),process.platform===`win32`&&k.removeMenu(),";

  const patched = applyPatchTwice(applyFramelessTitlebarMenuPatch, source);

  assert.equal(patched, source);
  assert.equal((patched.match(/process\.platform===`linux`&&k\.removeMenu\(\),/g) ?? []).length, 1);
  assert.doesNotMatch(patched, /setMenuBarVisibility/);
});

test("frameless-titlebar collapses the core-patched zoom overlay ternary", () => {
  const source = [
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "function codexLinuxTitleBarOverlay(e=1){return{color:a.nativeTheme.shouldUseDarkColors?`#111111`:o2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(30*e)}}",
    "setWindowZoom(e,t){let n=r.BrowserWindow.fromWebContents(e);n==null||this.windowAppearances.get(n.id)!==`primary`||(process.platform===`darwin`?n.setWindowButtonPosition(f6(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(t):b2(t))))}",
  ].join("");

  const patched = applyPatchTwice(applyFramelessTitlebarMainPatch, source);

  assert.match(
    patched,
    /process\.platform===`win32`&&\(this\.windowZooms\.set\(n\.id,t\),n\.setTitleBarOverlay\(b2\(t\)\)\)/,
  );
  assert.doesNotMatch(patched, /setTitleBarOverlay\(process\.platform===`linux`/);
  assert.doesNotMatch(patched, /process\.platform===`linux`[^;]*setTitleBarOverlay/);
});

test("frameless-titlebar maps Linux window controls chrome to native webview layout", () => {
  const source = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),mac:Object.freeze({legacy:Object.freeze({left:66+hyt,right:0}),modern:Object.freeze({left:76+hyt,right:0})}),applicationMenu:Object.freeze({left:0,right:138})});",
    "function Nvt(){return vKe()&&window.electronBridge?.showApplicationMenu!=null}",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`application-menu`;default:return`native`}}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.applicationMenu:eV.default;",
  ].join("");

  const patched = applyPatchTwice(applyFramelessTitlebarWebviewPatch, source);

  assert.equal(
    (patched.match(/applicationMenu:Object\.freeze\(\{left:0,right:0\}\)/g) ?? []).length,
    1,
  );
  assert.match(patched, /case`win32`:return`application-menu`;case`linux`:return`native`/);
  assert.match(patched, /function Nvt\(\)\{return!1\}/);
  assert.match(patched, /i\.includes\(`win`\)\|\|r\.includes\(`windows`\)\?t\?\?eV\.applicationMenu:eV\.default/);
  assert.doesNotMatch(patched, /case`win32`:case`linux`:return`application-menu`/);
  assert.doesNotMatch(patched, /showApplicationMenu/);
  assert.doesNotMatch(patched, /includes\(`linux`\)\?t\?\?eV\.applicationMenu/);
  assert.doesNotMatch(patched, /right:138/);
});

test("frameless-titlebar warns when only an unrelated disabled function matches bridge output", () => {
  const source = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:138})});",
    "function unrelated(){return!1}",
    "function Nvt(){return vKe()&&window.electronBridge?.showAppMenu!=null}",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`something-else`;default:return`native`}}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.appMenu:eV.default;",
  ].join("");

  const warnings = captureWarnings(() => applyFramelessTitlebarWebviewPatch(source));

  assert.deepEqual(warnings, [
    "WARN: Could not find Linux window controls chrome mapping - skipping frameless webview chrome patch",
  ]);
});
