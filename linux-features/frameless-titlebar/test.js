#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const {
  CHROME_MAPPING_ASSET_PATTERN,
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
    "function j9(e=1){return{height:Math.round(30*e)}}",
    "function A9(e,t){return{x:e.x*t,y:e.y*t}}const k9={x:10,y:12};",
    "class WindowManager{setWindowZoom(e,t){let n=_.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);",
    "n!=null&&(r===`primary`||process.platform===`darwin`&&r===`detached`)&&(process.platform===`darwin`?n.setWindowButtonPosition(A9(k9,t)):",
    "(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t))))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`detached`)return;",
    "let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(j9(this.windowZooms.get(e.id)))};return _.nativeTheme.on(`updated`,n),n(),()=>{_.nativeTheme.off(`updated`,n)}}}",
    "function windowOptions({appearance:e,opaqueWindowSurfaceEnabled:t,platform:n,windowZoom:r=1}){switch(e){",
    "case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:A9(k9,r),acceptFirstMouse:!0,...t?{}:{vibrancy:`menu`}}:",
    "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r)}:{titleBarStyle:`default`};",
    "case`detached`:return n===`darwin`?{titleBarStyle:`hiddenInset`,titleBarOverlay:!0,trafficLightPosition:A9(k9,r)}:{titleBarStyle:`hidden`,titleBarOverlay:j9(r)};",
    "case`secondary`:return n===`darwin`?t?{titleBarStyle:`default`}:{vibrancy:`menu`,titleBarStyle:`default`}:{titleBarStyle:`default`}}}",
  ].join("");
}

function aliasedMainFixture() {
  const aliases = { j9: "overlay", A9: "buttonPosition", k9: "position", e: "windowType", t: "zoom", n: "platform", r: "windowZoom" };
  return officialMainFixture().replace(/\b(j9|A9|k9|e|t|n|r)\b/g, (alias) => aliases[alias]);
}

function evaluateMainFixture(source, platform, appearance) {
  const events = [];
  const handlers = new Map();
  const window = {
    id: 1,
    isDestroyed: () => false,
    setTitleBarOverlay: (options) => events.push(["overlay", JSON.parse(JSON.stringify(options))]),
    setWindowButtonPosition: (position) => events.push(["buttons", JSON.parse(JSON.stringify(position))]),
  };
  const context = vm.createContext({
    process: { platform },
    _: {
      BrowserWindow: { fromWebContents: () => window },
      nativeTheme: {
        on: (event, callback) => { events.push(["on", event]); handlers.set(event, callback); },
        off: (event, callback) => { events.push(["off", event]); handlers.delete(event); },
      },
    },
  });
  vm.runInContext(source, context);
  const options = vm.runInContext(`windowOptions({appearance:${JSON.stringify(appearance)},platform:process.platform,windowZoom:2})`, context);
  const manager = vm.runInContext("new WindowManager()", context);
  manager.windowAppearances = new Map([[1, appearance]]);
  manager.windowZooms = new Map();
  manager.setWindowZoom({}, 2);
  const cleanup = manager.installApplicationMenuTitleBarOverlaySync(window, appearance);
  handlers.get("updated")?.();
  cleanup?.();
  return { options: JSON.parse(JSON.stringify(options)), events, zooms: [...manager.windowZooms] };
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

test("main-process patch removes Linux primary and detached overlays and is idempotent", () => {
  const source = officialMainFixture();
  assert.equal(framelessTitlebarMainContract(source), "current");
  const patched = applyFramelessTitlebarMainPatch(source);
  assert.notEqual(patched, source);
  assert.equal(framelessTitlebarMainContract(patched), "patched");
  assert.equal(applyFramelessTitlebarMainPatch(patched), patched);
  for (const appearance of ["primary", "detached"]) {
    const result = evaluateMainFixture(patched, "linux", appearance);
    assert.deepEqual(result.options, { titleBarStyle: "hidden" });
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.zooms, []);
    assert.ok(evaluateMainFixture(source, "linux", appearance).events.some(([event]) => event === "overlay"));
  }
});

test("main-process patch preserves Windows and macOS options, zoom, and theme synchronization", () => {
  const source = officialMainFixture();
  const patched = applyFramelessTitlebarMainPatch(source);
  for (const platform of ["win32", "darwin"]) {
    for (const appearance of ["primary", "detached", "secondary"]) {
      assert.deepEqual(evaluateMainFixture(patched, platform, appearance), evaluateMainFixture(source, platform, appearance));
    }
  }
  assert.deepEqual(evaluateMainFixture(patched, "linux", "secondary"), evaluateMainFixture(source, "linux", "secondary"));
});

test("main-process patch preserves current minified aliases", () => {
  const source = aliasedMainFixture();
  assert.equal(framelessTitlebarMainContract(source), "current");
  const patched = applyFramelessTitlebarMainPatch(source);
  assert.notEqual(patched, source);
  assert.equal(framelessTitlebarMainContract(patched), "patched");
  assert.match(patched, /platform===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:overlay\(windowZoom\)/);
  assert.match(patched, /platform===`linux`\?\{titleBarStyle:`hidden`\}/);
  assert.match(patched, /this\.windowZooms\.set\(platform\.id,zoom\),platform\.setTitleBarOverlay\(overlay\(zoom\)\)/);
  assert.match(patched, /installApplicationMenuTitleBarOverlaySync\(windowType,zoom\)\{if\(process\.platform!==`win32`\|\|zoom!==`primary`&&zoom!==`detached`\)return;/);
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
  const currentAnchors = [
    "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r)}",
    "case`detached`:return n===`darwin`?{titleBarStyle:`hiddenInset`,titleBarOverlay:!0,trafficLightPosition:A9(k9,r)}:{titleBarStyle:`hidden`,titleBarOverlay:j9(r)}",
    "(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t)))",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`detached`)return;",
  ];
  const patchedAnchors = [
    "n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r)}:n===`linux`?{titleBarStyle:`hidden`}",
    "case`detached`:return n===`darwin`?{titleBarStyle:`hiddenInset`,titleBarOverlay:!0,trafficLightPosition:A9(k9,r)}:n===`linux`?{titleBarStyle:`hidden`}:{titleBarStyle:`hidden`,titleBarOverlay:j9(r)}",
    "process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t)))",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`||t!==`primary`&&t!==`detached`)return;",
  ];
  const sources = [current + current, patched + patched, current + patched];
  for (let index = 0; index < currentAnchors.length; index++) {
    assert.ok(current.includes(currentAnchors[index]));
    assert.ok(patched.includes(patchedAnchors[index]));
    sources.push(
      current.replace(currentAnchors[index], ""),
      patched.replace(patchedAnchors[index], ""),
      current + currentAnchors[index],
      patched + patchedAnchors[index],
      current.replace(currentAnchors[index], patchedAnchors[index]),
      patched.replace(patchedAnchors[index], currentAnchors[index]),
    );
  }
  sources.push(
    current.replace("titleBarOverlay:j9(r)", "titleBarOverlay:j9(r,1)"),
    patched.replace("n===`linux`?{titleBarStyle:`hidden`}", "n===`linux`?{titleBarStyle:`default`}"),
    current.replace("trafficLightPosition:A9(k9,r)}:{titleBarStyle:`hidden`", "trafficLightPosition:A9(k9,r,1)}:{titleBarStyle:`hidden`"),
  );
  for (const source of sources) {
    const result = captureWarnings(() => applyFramelessTitlebarMainPatch(source));
    assert.equal(framelessTitlebarMainContract(source), "drifted");
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

test("webview patch preserves Windows, macOS, and browser chrome behavior", () => {
  const source = officialWebviewFixture();
  const patched = applyFramelessTitlebarWebviewPatch(source);
  const originalMapping = vm.runInNewContext(`${source};h3e`);
  const patchedMapping = vm.runInNewContext(`${patched};h3e`);
  for (const engine of ["electron", "browser"]) {
    for (const platform of ["linux", "win32", "darwin", "unknown"]) {
      const expected = engine === "electron" && platform === "linux" ? "native" : originalMapping(engine, platform);
      assert.equal(patchedMapping(engine, platform), expected);
    }
  }
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

test("webview descriptor selects the current shared chrome mapping across hash changes", () => {
  const descriptor = descriptors.find(({ id }) => id === "webview-chrome-mapping");
  assert.match("app-shared-HashNext1.js", CHROME_MAPPING_ASSET_PATTERN);
  assert.doesNotMatch("connect-app-host-HashNext1.js", CHROME_MAPPING_ASSET_PATTERN);
  assert.equal(descriptor.assetMatch(officialWebviewFixture()), true);
  assert.equal(descriptor.assetMatch(applyFramelessTitlebarWebviewPatch(officialWebviewFixture())), true);
  assert.equal(descriptor.assetMatch("export{chrome}"), false);
});
