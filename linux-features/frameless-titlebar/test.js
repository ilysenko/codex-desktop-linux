#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const {
  APP_INITIAL_ASSET_PATTERN,
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarWebviewPatch,
  descriptors,
  framelessTitlebarMainContract,
  framelessTitlebarWebviewContract,
} = require("./patch.js");

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function officialMainFixture() {
  return [
    "function A9(e=1){return{color:O9,symbolColor:l.nativeTheme.shouldUseDarkColors?LTe:ITe,height:Math.round(FTe*e)}}",
    "setWindowZoom(e,t){let n=l.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);",
    "n==null||r!==`primary`&&r!==`quickChat`||(process.platform===`darwin`?n.setWindowButtonPosition(k9(t)):",
    "(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(A9(t))))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;",
    "let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(A9(this.windowZooms.get(e.id)))};return l.nativeTheme.on(`updated`,n),n(),()=>{l.nativeTheme.off(`updated`,n)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`}:",
    "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`}",
  ].join("");
}

function aliasedMainFixture() {
  return [
    "setWindowZoom(contents,zoom){let window=l.BrowserWindow.fromWebContents(contents),appearance=window&&this.windowAppearances.get(window.id);",
    "window==null||appearance!==`primary`&&appearance!==`quickChat`||(process.platform===`darwin`?window.setWindowButtonPosition(k9(zoom)):",
    "(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(window.id,zoom),window.setTitleBarOverlay(overlay(zoom))))}",
    "installApplicationMenuTitleBarOverlaySync(window,windowType){if(process.platform!==`win32`&&process.platform!==`linux`||windowType!==`primary`&&windowType!==`quickChat`)return;}",
    "platform===`win32`||platform===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:overlay(zoom),...windowType===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`}",
  ].join("");
}

function officialWebviewFixture() {
  return "function h3e(e,t){if(e!==`electron`)return`native`;switch(t){case`win32`:case`linux`:return`application-menu`;case`darwin`:case`unknown`:return`native`}}";
}

test("frameless-titlebar is disabled by default and exposes standalone descriptors", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "frameless-titlebar-"));
  try {
    const config = path.join(temp, "features.json");
    fs.writeFileSync(config, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config }), []);
    fs.writeFileSync(config, '{"enabled":["frameless-titlebar"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config });
    assert.deepEqual(
      loaded.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
      [
        ["feature:frameless-titlebar:main-process", "main-bundle", "optional"],
        ["feature:frameless-titlebar:webview-chrome-mapping", "webview-asset", "optional"],
      ],
    );
    assert.ok(loaded.every(({ composesPatches }) => composesPatches == null));
    assert.deepEqual(
      descriptors.map(({ id, phase }) => [id, phase]),
      [
        ["main-process", "main-bundle"],
        ["webview-chrome-mapping", "webview-asset"],
      ],
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("main-process patch removes Linux titleBarOverlay and is idempotent", () => {
  const source = officialMainFixture();
  assert.equal(framelessTitlebarMainContract(source), "current");
  const patched = applyFramelessTitlebarMainPatch(source);
  assert.notEqual(patched, source);
  assert.equal(framelessTitlebarMainContract(patched), "patched");
  assert.equal(applyFramelessTitlebarMainPatch(patched), patched);
  assert.match(patched, /n===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:A9\(r\)/);
  assert.match(patched, /n===`linux`\?\{titleBarStyle:`hidden`,\.\.\.e===`quickChat`\?\{resizable:!0\}:\{\}\}/);
  assert.doesNotMatch(patched, /n===`win32`\|\|n===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay/);
  assert.match(patched, /process\.platform===`win32`&&\(this\.windowZooms\.set\(n\.id,t\),n\.setTitleBarOverlay\(A9\(t\)\)\)/);
  assert.doesNotMatch(patched, /process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set/);
  assert.match(
    patched,
    /installApplicationMenuTitleBarOverlaySync\(e,t\)\{if\(process\.platform!==`win32`\|\|t!==`primary`&&t!==`quickChat`\)return;/,
  );
  assert.match(patched, /titleBarStyle:`hiddenInset`/);
});

test("main-process patch preserves current minified aliases", () => {
  const source = aliasedMainFixture();
  const patched = applyFramelessTitlebarMainPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /platform===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:overlay\(zoom\)/);
  assert.match(patched, /platform===`linux`\?\{titleBarStyle:`hidden`,\.\.\.windowType===`quickChat`\?\{resizable:!0\}:\{\}\}/);
  assert.match(patched, /this\.windowZooms\.set\(window\.id,zoom\),window\.setTitleBarOverlay\(overlay\(zoom\)\)/);
  assert.match(
    patched,
    /installApplicationMenuTitleBarOverlaySync\(window,windowType\)\{if\(process\.platform!==`win32`\|\|windowType!==`primary`&&windowType!==`quickChat`\)return;/,
  );
  assert.equal(applyFramelessTitlebarMainPatch(patched), patched);
});

test("already-patched main-process contracts do not warn", () => {
  const patched = applyFramelessTitlebarMainPatch(officialMainFixture());
  const result = captureWarnings(() => applyFramelessTitlebarMainPatch(patched));
  assert.equal(result.value, patched);
  assert.deepEqual(result.warnings, []);
});

test("main-process patch rejects incomplete, duplicate, and mixed contracts byte-identically", () => {
  const current = officialMainFixture();
  const patched = applyFramelessTitlebarMainPatch(current);
  const sources = [
    current.replace("titleBarOverlay:A9(r),", ""),
    current.replace("installApplicationMenuTitleBarOverlaySync", "installTitleBarOverlaySync"),
    current.replace("(process.platform===`win32`||process.platform===`linux`)", "(process.platform===`win32`)"),
    patched.replace("n===`linux`?{titleBarStyle:`hidden`", "n===`linux`?{titleBarStyle:`default`"),
    patched.replace("process.platform===`win32`&&(this.windowZooms.set", "process.platform===`linux`&&(this.windowZooms.set"),
    current + current,
    patched + patched,
    current + patched,
    current.replace(
      "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}",
      "n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}:n===`linux`?{titleBarStyle:`hidden`,...e===`quickChat`?{resizable:!0}:{}}",
    ),
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applyFramelessTitlebarMainPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current frameless-titlebar main-process contract/);
  }
});

test("unrecognized main-process contracts warn instead of reporting false already-applied", () => {
  const source = "function driftedMain(){return {titleBarStyle:`default`}}";
  const result = captureWarnings(() => applyFramelessTitlebarMainPatch(source));
  assert.equal(result.value, source);
  assert.equal(framelessTitlebarMainContract(source), "drifted");
  assert.match(result.warnings.join("\n"), /current frameless-titlebar main-process contract/);
});

test("webview patch remaps Linux chrome and is idempotent", () => {
  const source = officialWebviewFixture();
  assert.equal(framelessTitlebarWebviewContract(source), "current");
  const patched = applyFramelessTitlebarWebviewPatch(source);
  assert.notEqual(patched, source);
  assert.equal(framelessTitlebarWebviewContract(patched), "patched");
  assert.equal(applyFramelessTitlebarWebviewPatch(patched), patched);
  assert.match(patched, /case`linux`:return`native`/);
  assert.doesNotMatch(patched, /case`win32`:case`linux`:return`application-menu`/);
});

test("already-patched webview contracts do not warn", () => {
  const patched = applyFramelessTitlebarWebviewPatch(officialWebviewFixture());
  const result = captureWarnings(() => applyFramelessTitlebarWebviewPatch(patched));
  assert.equal(result.value, patched);
  assert.deepEqual(result.warnings, []);
});

test("webview patch rejects incomplete, duplicate, and mixed contracts byte-identically", () => {
  const current = officialWebviewFixture();
  const patched = applyFramelessTitlebarWebviewPatch(current);
  const sources = [
    current.replace("case`win32`:case`linux`:return`application-menu`", "case`win32`:return`application-menu`"),
    patched.replace("case`linux`:return`native`", "case`linux`:return`application-menu`"),
    current + current,
    patched + patched,
    current + patched,
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applyFramelessTitlebarWebviewPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current frameless-titlebar webview contract/);
  }
});

test("unrecognized webview contracts warn instead of reporting false already-applied", () => {
  const source = "function driftedWebview(){return `native`}";
  const result = captureWarnings(() => applyFramelessTitlebarWebviewPatch(source));
  assert.equal(result.value, source);
  assert.equal(framelessTitlebarWebviewContract(source), "drifted");
  assert.match(result.warnings.join("\n"), /current frameless-titlebar webview contract/);
});

test("webview descriptor selects current contracts across renderer hash changes", () => {
  const descriptor = descriptors.find(({ id }) => id === "webview-chrome-mapping");
  assert.match("app-initial-HashNext1.js", APP_INITIAL_ASSET_PATTERN);
  assert.doesNotMatch("app-initial~app-main~page-CMpPiY3-.js", APP_INITIAL_ASSET_PATTERN);
  assert.equal(descriptor.assetMatch(officialWebviewFixture()), true);
  assert.equal(descriptor.assetMatch(applyFramelessTitlebarWebviewPatch(officialWebviewFixture())), true);
  assert.equal(descriptor.assetMatch("export{chrome}"), false);
});
