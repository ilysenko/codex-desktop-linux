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
  MENU_SHADOW_CSS,
  MENU_SHADOW_RUNTIME_MARKER,
  MENU_SHADOW_SELECTORS,
  MENU_SHADOW_STYLE_ID,
  applyFramelessTitlebarApplicationMenuPatch,
  applyFramelessTitlebarBranchPatch,
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarMenuShadowPatch,
  applyFramelessTitlebarOverlaySyncPatch,
  applyFramelessTitlebarWebviewPatch,
  framelessTitlebarMenuShadowRuntimeSource,
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
    assert.match(
      "app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-BqLP6EDd.js",
      webviewPatch.pattern,
    );
    assert.match(
      "app-initial~artifact-tab-content.electron~app-main~new-thread-panel-page~onboarding-page~pr~el73lghr-qHKfocxV.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch(
      "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-abc.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch("app-initial~app-main~onboarding-page-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("use-window-controls-safe-area-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("app-initial~app-main~onboarding-page~debug-window-page-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("app-main-abc.js", webviewPatch.pattern);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("frameless-titlebar removes current Linux overlay controls without changing quick chat", () => {
  const source = [
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:A9(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "setWindowZoom(e,t){let n=c.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);n==null||r!==`primary`&&r!==`quickChat`||(process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(t):j9(t))))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(this.windowZooms.get(e.id)):j9(this.windowZooms.get(e.id)))};return c.nativeTheme.on(`updated`,n),n(),()=>{c.nativeTheme.off(`updated`,n)}}",
    "(process.platform===`win32`||process.platform===`linux`)&&k.removeMenu(),",
    "let Bt=c.Menu.buildFromTemplate(zt);c.Menu.setApplicationMenu(Bt);",
  ].join("");
  let patched;
  const warnings = captureWarnings(() => {
    patched = applyPatchTwice(applyFramelessTitlebarMainPatch, source);
  });

  assert.deepEqual(warnings, []);
  assert.match(
    patched,
    /n===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:j9\(r\),\.\.\.e===`quickChat`\?\{resizable:!0\}:\{\}\}/,
  );
  assert.match(
    patched,
    /n===`linux`\?\{titleBarStyle:`hidden`,\.\.\.e===`quickChat`\?\{resizable:!0\}:\{\}\}/,
  );
  assert.match(
    patched,
    /process\.platform===`win32`&&\(this\.windowZooms\.set\(n\.id,t\),n\.setTitleBarOverlay\(j9\(t\)\)\)/,
  );
  assert.match(patched, /if\(process\.platform!==`win32`\|\|t!==`primary`&&t!==`quickChat`\)return/);
  assert.match(
    patched,
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&k\.removeMenu\(\),/,
  );
  assert.match(patched, /c\.Menu\.setApplicationMenu\(process\.platform===`linux`\?null:Bt\)/);
  assert.doesNotMatch(patched, /titleBarOverlay:codexLinuxTitleBarOverlay/);
  assert.doesNotMatch(patched, /process\.platform===`linux`[^;]*setTitleBarOverlay/);
});

test("frameless-titlebar composes with the current native-titlebar patch shape", () => {
  const source =
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:n===`linux`?codexLinuxTitleBarOverlay(r):j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};";
  let patched;
  const warnings = captureWarnings(() => {
    patched = applyPatchTwice(applyFramelessTitlebarBranchPatch, source);
  });

  assert.deepEqual(warnings, []);
  assert.match(
    patched,
    /n===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:j9\(r\),\.\.\.e===`quickChat`\?\{resizable:!0\}:\{\}\}/,
  );
  assert.match(
    patched,
    /n===`linux`\?\{titleBarStyle:`hidden`,\.\.\.e===`quickChat`\?\{resizable:!0\}:\{\}\}/,
  );
  assert.doesNotMatch(patched, /titleBarOverlay:n===`linux`/);
});

test("frameless-titlebar suppresses the global Electron application menu on Linux", () => {
  const source =
    "let Bt=c.Menu.buildFromTemplate(zt);c.Menu.setApplicationMenu(Bt);";

  const patched = applyPatchTwice(applyFramelessTitlebarApplicationMenuPatch, source);

  assert.equal(
    patched,
    "let Bt=c.Menu.buildFromTemplate(zt);c.Menu.setApplicationMenu(process.platform===`linux`?null:Bt);",
  );
});

test("frameless-titlebar injects a webview style to remove menu shadows", () => {
  const source = "function app(){return `ready`}";
  const runtimeSource = framelessTitlebarMenuShadowRuntimeSource();

  assert.match(runtimeSource, new RegExp(MENU_SHADOW_RUNTIME_MARKER));
  assert.match(runtimeSource, new RegExp(MENU_SHADOW_STYLE_ID));
  assert.match(runtimeSource, /data-radix-popper-content-wrapper/);
  assert.match(runtimeSource, /box-shadow:none!important/);

  const patched = applyPatchTwice(applyFramelessTitlebarMenuShadowPatch, source);

  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(MENU_SHADOW_RUNTIME_MARKER));
  assert.match(patched, new RegExp(MENU_SHADOW_STYLE_ID));
  assert.match(patched, /box-shadow:none!important/);
  assert.equal((patched.match(new RegExp(MENU_SHADOW_RUNTIME_MARKER, "g")) ?? []).length, 1);
  assert.match(MENU_SHADOW_SELECTORS, /^\[data-radix-popper-content-wrapper\]>\*,\[role="menu"\]\[data-side\]/);
  assert.equal(MENU_SHADOW_CSS.includes("[role=\"menu\"][data-state]"), true);
});

test("frameless-titlebar reports current main-process drift", () => {
  const titlebarSource =
    "n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay(r),...e===`quickChat`?{resizable:!1}:{}}:";
  const overlaySource = [
    "setWindowZoom(e,t){(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(process.platform===`linux`?linuxOverlayV2(t):j9(t)))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(process.platform===`linux`?linuxOverlayV2(this.windowZooms.get(e.id)):j9(this.windowZooms.get(e.id)))};return c.nativeTheme.on(`updated`,n),n(),()=>{c.nativeTheme.off(`updated`,n)}}",
  ].join("");

  assert.deepEqual(captureWarnings(() => applyFramelessTitlebarBranchPatch(titlebarSource)), [
    "WARN: Could not find primary BrowserWindow titlebar snippet - skipping frameless titlebar branch patch",
  ]);
  assert.deepEqual(captureWarnings(() => applyFramelessTitlebarOverlaySyncPatch(overlaySource)), [
    "WARN: Could not find setWindowZoom titlebar overlay snippet - skipping frameless zoom patch",
    "WARN: Could not find application menu titlebar overlay sync snippet - skipping frameless sync patch",
  ]);
});

test("frameless-titlebar maps Linux window controls chrome to native webview layout", () => {
  const layoutSource = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),mac:Object.freeze({legacy:Object.freeze({left:66+hyt,right:0}),modern:Object.freeze({left:76+hyt,right:0})}),applicationMenu:Object.freeze({left:0,right:138})});",
    "function Nvt(){return vKe()&&window.electronBridge?.showApplicationMenu!=null}",
    "function menu(){if(!Nvt())return null;let i=window.electronBridge?.showApplicationMenu;return i}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.applicationMenu:eV.default;",
  ].join("");
  const chromeSource = [
    "function chrome(e){switch(e){case`win32`:case`linux`:return`application-menu`;case`darwin`:case`unknown`:return`native`}}",
    "function usesChrome(){return document.documentElement.dataset.codexWindowChrome===`application-menu`}",
  ].join("");

  const patchedLayout = applyPatchTwice(applyFramelessTitlebarWebviewPatch, layoutSource);
  const patchedChrome = applyPatchTwice(applyFramelessTitlebarWebviewPatch, chromeSource);

  assert.equal(
    (patchedLayout.match(/applicationMenu:Object\.freeze\(\{left:0,right:0\}\)/g) ?? []).length,
    1,
  );
  assert.match(patchedChrome, /case`win32`:return`application-menu`;case`linux`:return`native`/);
  assert.match(patchedLayout, /function Nvt\(\)\{return!1\}/);
  assert.match(patchedLayout, /i\.includes\(`win`\)\|\|r\.includes\(`windows`\)\?t\?\?eV\.applicationMenu:eV\.default/);
  assert.doesNotMatch(patchedChrome, /case`win32`:case`linux`:return`application-menu`/);
  assert.doesNotMatch(patchedLayout, /function Nvt\(\)\{return [^}]*showApplicationMenu/);
  assert.doesNotMatch(patchedLayout, /includes\(`linux`\)\?t\?\?eV\.applicationMenu/);
  assert.doesNotMatch(patchedLayout, /right:138/);
});

test("frameless-titlebar reports each current webview sub-contract drift", () => {
  const source = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:138})});",
    "function unrelated(){return!1}",
    "function Nvt(){return vKe()&&window.electronBridge?.showAppMenu!=null}",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`something-else`;default:return`native`}}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.appMenu:eV.default;",
  ].join("");

  const warnings = captureWarnings(() => applyFramelessTitlebarWebviewPatch(source));

  assert.deepEqual(warnings, [
    "WARN: Could not find application menu browser gate - skipping frameless webview platform patch",
    "WARN: Could not find application menu bridge guard - skipping frameless webview bridge patch",
  ]);

  const chromeDrift = [
    "function chrome(e){switch(e){case`win32`:return`application-menu`;case`linux`:return`overlay-v2`;default:return`native`}}",
    "function usesChrome(){return document.documentElement.dataset.codexWindowChrome===`application-menu`}",
  ].join("");
  assert.deepEqual(captureWarnings(() => applyFramelessTitlebarWebviewPatch(chromeDrift)), [
    "WARN: Could not find Linux window controls chrome mapping - skipping frameless webview chrome patch",
  ]);
});
