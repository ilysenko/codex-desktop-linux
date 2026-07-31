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
  applyLinuxNativeTitlebarPatch,
} = require("../../scripts/patches/impl/main-process/window.js");
const {
  applyLinuxWindowControlsSafeAreaPatch,
} = require("../../scripts/patches/impl/webview/index.js");
const {
  applyFramelessTitlebarBranchPatch,
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarOverlaySyncPatch,
  applyFramelessTitlebarWebviewPatch,
  applyFramelessTitlebarWebviewTransforms,
} = require("./patch.js");

const CORE_CONTEXT = {
  enabledFeatureIds: ["frameless-titlebar"],
  patchCompositionDelegates: {
    "linux-native-titlebar": ["frameless-titlebar"],
    "linux-window-controls-safe-area": ["frameless-titlebar"],
  },
};
const FEATURE_CONTEXT = {
  enabledFeatureIds: ["frameless-titlebar"],
  feature: { id: "frameless-titlebar" },
};

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
  const helperDir = path.join(
    featuresRoot,
    "..",
    "scripts",
    "patches",
    "lib",
  );
  fs.mkdirSync(featureDir, { recursive: true });
  fs.mkdirSync(helperDir, { recursive: true });
  for (const name of ["feature.json", "README.md", "patch.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(featureDir, name));
  }
  fs.copyFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "scripts",
      "patches",
      "lib",
      "composition-delegation.js",
    ),
    path.join(helperDir, "composition-delegation.js"),
  );
}

function nativeTitlebarCompositionFixture() {
  return [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function j9(e=1){return{color:i2,symbolColor:c.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:A9(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "setWindowZoom(e,t){let n=c.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);n==null||r!==`primary`&&r!==`quickChat`||(process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t))))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(j9(this.windowZooms.get(e.id)))};return c.nativeTheme.on(`updated`,n),n(),()=>{c.nativeTheme.off(`updated`,n)}}",
  ].join("");
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
    assert.match("app-initial-BTphDPeq.js", webviewPatch.pattern);
    assert.doesNotMatch(
      "app-initial~app-main~hotkey-window-new-thread-page~hotkey-window-home-page~composer-utility-bar-D9zyQF1n.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch(
      "app-initial~app-main~onboarding-page-CIkoyvFz.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch(
      "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-CnQKtQ6U.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch(
      "app-initial~artifact-tab-content.electron~app-main~appgen-settings-page~page~pull-request-r~napudbu0-BLPFEZVT.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch(
      "app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-BqLP6EDd.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch(
      "app-initial~artifact-tab-content.electron~app-main~new-thread-panel-page~onboarding-page~pr~el73lghr-qHKfocxV.js",
      webviewPatch.pattern,
    );
    assert.doesNotMatch("use-window-controls-safe-area-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("app-initial~app-main~onboarding-page~debug-window-page-abc.js", webviewPatch.pattern);
    assert.doesNotMatch("app-main-abc.js", webviewPatch.pattern);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("frameless-titlebar removes current Linux overlay controls from primary and quick chat windows", () => {
  const source = [
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:A9(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:n===`linux`?codexLinuxTitleBarOverlay(r):j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "setWindowZoom(e,t){let n=c.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);n==null||r!==`primary`&&r!==`quickChat`||(process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(t):j9(t))))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(this.windowZooms.get(e.id)):j9(this.windowZooms.get(e.id)))};return c.nativeTheme.on(`updated`,n),n(),()=>{c.nativeTheme.off(`updated`,n)}}",
    "(process.platform===`win32`||process.platform===`linux`)&&k.removeMenu(),",
  ].join("");
  let patched;
  const warnings = captureWarnings(() => {
    patched = applyPatchTwice(
      (currentSource) =>
        applyFramelessTitlebarOverlaySyncPatch(
          applyFramelessTitlebarBranchPatch(currentSource),
        ),
      source,
    );
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
  assert.match(
    patched,
    /if\(process\.platform!==`win32`\|\|t!==`primary`&&t!==`quickChat`\)return/,
  );
  assert.match(
    patched,
    /e\.setTitleBarOverlay\(j9\(this\.windowZooms\.get\(e\.id\)\)\)/,
  );
  assert.match(
    patched,
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&k\.removeMenu\(\),/,
  );
  assert.doesNotMatch(
    patched,
    /n===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay/,
  );
  assert.doesNotMatch(patched, /process\.platform===`linux`[^;]{0,300}setTitleBarOverlay/);
});

test("frameless-titlebar descriptors require their completed core owners", () => {
  const mainSource =
    "case`primary`:return n===`linux`?{titleBarStyle:`hidden`}:{};";
  const webviewSource =
    "applicationMenu:Object.freeze({left:0,right:138})";

  assert.deepEqual(
    captureWarnings(() => {
      assert.equal(applyFramelessTitlebarMainPatch(mainSource), mainSource);
    }),
    [
      "WARN: Could not find completed Linux native titlebar patch for frameless composition - leaving bundle unchanged",
    ],
  );
  assert.deepEqual(
    captureWarnings(() => {
      assert.equal(
        applyFramelessTitlebarWebviewPatch(webviewSource),
        webviewSource,
      );
    }),
    [
      "WARN: Could not find completed Linux window-controls safe-area patch for frameless composition - leaving asset unchanged",
    ],
  );
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

test("native-titlebar remains complete after frameless-titlebar composition", () => {
  const corePatched = applyLinuxNativeTitlebarPatch(
    nativeTitlebarCompositionFixture(),
  );
  const composed = applyFramelessTitlebarMainPatch(corePatched);
  let rerun;
  const warnings = captureWarnings(() => {
    rerun = applyLinuxNativeTitlebarPatch(composed, CORE_CONTEXT);
  });

  assert.equal(rerun, composed);
  assert.deepEqual(warnings, []);
});

test("frameless-titlebar owns validation after native-titlebar delegation", () => {
  const corePatched = applyLinuxNativeTitlebarPatch(
    nativeTitlebarCompositionFixture(),
  );
  const composed = applyFramelessTitlebarMainPatch(corePatched);
  const incompleteCore = composed.replace(
    "function codexLinuxTitleBarOverlay",
    "function codexLinuxTitleBarOverlayMissing",
  );
  let rerun;
  const coreWarnings = captureWarnings(() => {
    rerun = applyLinuxNativeTitlebarPatch(incompleteCore, CORE_CONTEXT);
  });
  assert.equal(rerun, incompleteCore);
  assert.deepEqual(coreWarnings, []);
  const featureWarnings = captureWarnings(() => {
    rerun = applyFramelessTitlebarMainPatch(
      incompleteCore,
      FEATURE_CONTEXT,
    );
  });
  assert.equal(rerun, incompleteCore);
  assert.deepEqual(featureWarnings, [
    "WARN: Could not validate delegated frameless titlebar main-process composition - leaving bundle unchanged",
  ]);

  const featureVariants = [
    composed.replace(
      "process.platform===`win32`&&(this.windowZooms.set",
      "(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set",
    ),
    composed.replace(
      "if(process.platform!==`win32`||t!==`primary`",
      "if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`",
    ),
    composed.replace(
      /setWindowZoom[\s\S]*?(?=installApplicationMenuTitleBarOverlaySync)/u,
      "",
    ),
    composed.replace(
      /installApplicationMenuTitleBarOverlaySync[\s\S]*$/u,
      "",
    ),
  ];

  for (const source of featureVariants) {
    const warnings = captureWarnings(() => {
      rerun = applyFramelessTitlebarMainPatch(source, FEATURE_CONTEXT);
    });
    assert.equal(rerun, source);
    assert.deepEqual(warnings, [
      "WARN: Could not validate delegated frameless titlebar main-process composition - leaving bundle unchanged",
    ]);
  }
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

  const patchedLayout = applyPatchTwice(applyFramelessTitlebarWebviewTransforms, layoutSource);
  const patchedChrome = applyPatchTwice(applyFramelessTitlebarWebviewTransforms, chromeSource);

  assert.equal(
    (patchedLayout.match(/applicationMenu:Object\.freeze\(\{left:0,right:0\}\)/g) ?? []).length,
    1,
  );
  assert.match(patchedChrome, /case`win32`:return`application-menu`;case`linux`:return`native`/);
  assert.match(patchedLayout, /i\.includes\(`win`\)\|\|r\.includes\(`windows`\)\?t\?\?eV\.applicationMenu:eV\.default/);
  assert.doesNotMatch(patchedChrome, /case`win32`:case`linux`:return`application-menu`/);
  assert.doesNotMatch(patchedLayout, /includes\(`linux`\)\?t\?\?eV\.applicationMenu/);
  assert.doesNotMatch(patchedLayout, /right:138/);
});

test("frameless-titlebar retains standard end padding after the core safe-area patch", () => {
  assert.equal(
    applyPatchTwice(
      applyFramelessTitlebarWebviewTransforms,
      "jsx(slot,{codexLinuxUseWindowControlsSafeArea:!t,side:`end`})",
    ),
    "jsx(slot,{codexLinuxUseWindowControlsSafeArea:!1,side:`end`})",
  );
});

test("frameless-titlebar composes idempotently with the core safe-area patch", () => {
  const source = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:0})});",
    "function ol({isHeaderEdgeScroll:e,isApplicationMenuBarEnabled:t}){return jsx(sl,{entries:h,fitWidth:r,slotWidth:u,side:`end`})}",
    "function sl({entries:e,fitWidth:t,side:n,slotWidth:r}){let i=e.some(({align:e})=>e===`end`),o=a({\"pe-2\":n===`start`&&i||n===`end`});return jsx(o)}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.applicationMenu:eV.default;",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`application-menu`;default:return`native`}}",
  ].join("");
  const corePatched = applyLinuxWindowControlsSafeAreaPatch(source);
  const composed = applyFramelessTitlebarWebviewPatch(corePatched);

  assert.equal(
    applyLinuxWindowControlsSafeAreaPatch(composed, CORE_CONTEXT),
    composed,
  );
  assert.equal(
    applyFramelessTitlebarWebviewPatch(composed, FEATURE_CONTEXT),
    composed,
  );
  assert.deepEqual(
    captureWarnings(() =>
      applyLinuxWindowControlsSafeAreaPatch(composed, CORE_CONTEXT)),
    [],
  );
});

test("frameless-titlebar owns safe-area validation after core delegation", () => {
  const stockSource = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:0})});",
    "function ol({isHeaderEdgeScroll:e,isApplicationMenuBarEnabled:t}){return jsx(sl,{entries:h,fitWidth:r,slotWidth:u,side:`end`})}",
    "function sl({entries:e,fitWidth:t,side:n,slotWidth:r}){let i=e.some(({align:e})=>e===`end`),o=a({\"pe-2\":n===`start`&&i||n===`end`});return jsx(o)}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.applicationMenu:eV.default;",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`application-menu`;default:return`native`}}",
  ].join("");
  const composed = applyFramelessTitlebarWebviewPatch(
    applyLinuxWindowControlsSafeAreaPatch(stockSource),
  );
  const damagedVariants = [
    composed.replace(
      ",codexLinuxUseWindowControlsSafeArea}){",
      "}){",
    ),
    composed.replace(
      "i.includes(`win`)||r.includes(`windows`)?t??eV.applicationMenu:eV.default",
      "i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.applicationMenu:eV.default",
    ),
    composed.replace(
      "case`win32`:return`application-menu`;case`linux`:return`native`",
      "case`win32`:case`linux`:return`application-menu`",
    ),
  ];

  for (const source of damagedVariants) {
    assert.notEqual(source, composed);
    const coreWarnings = captureWarnings(() => {
      assert.equal(
        applyLinuxWindowControlsSafeAreaPatch(source, CORE_CONTEXT),
        source,
      );
    });
    assert.deepEqual(coreWarnings, []);

    const featureWarnings = captureWarnings(() => {
      assert.equal(
        applyFramelessTitlebarWebviewPatch(source, FEATURE_CONTEXT),
        source,
      );
    });
    assert.deepEqual(featureWarnings, [
      "WARN: Could not validate delegated frameless Linux window-controls safe-area composition - leaving asset unchanged",
    ]);
  }
});

test("frameless-titlebar rejects a non-numeric inset hidden beside a valid delegated owner", () => {
  const stockSource = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:0})});",
    "var fV=Object.freeze({applicationMenu:Object.freeze({left:0,right:0})});",
    "function ol({isHeaderEdgeScroll:e,isApplicationMenuBarEnabled:t}){return jsx(sl,{entries:h,fitWidth:r,slotWidth:u,side:`end`})}",
    "function sl({entries:e,fitWidth:t,side:n,slotWidth:r}){let i=e.some(({align:e})=>e===`end`),o=a({\"pe-2\":n===`start`&&i||n===`end`});return jsx(o)}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.applicationMenu:eV.default;",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`application-menu`;default:return`native`}}",
  ].join("");
  const composed = applyFramelessTitlebarWebviewPatch(
    applyLinuxWindowControlsSafeAreaPatch(stockSource),
  );
  const damaged = composed.replace(
    "applicationMenu:Object.freeze({left:0,right:0})",
    "applicationMenu:Object.freeze({left:0,right:dynamicInset})",
  );

  const warnings = captureWarnings(() => {
    assert.equal(
      applyFramelessTitlebarWebviewPatch(damaged, FEATURE_CONTEXT),
      damaged,
    );
  });
  assert.deepEqual(warnings, [
    "WARN: Could not validate delegated frameless Linux window-controls safe-area composition - leaving asset unchanged",
  ]);
});

test("frameless-titlebar reports each current webview sub-contract drift", () => {
  const source = [
    "var eV=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:138})});",
    "function unrelated(){return!1}",
    "function Nvt(){return vKe()&&window.electronBridge?.showAppMenu!=null}",
    "function chrome(e){switch(e){case`win32`:case`linux`:return`something-else`;default:return`native`}}",
    "let newer=i.includes(`win`)||r.includes(`windows`)||i.includes(`linux`)?t??eV.appMenu:eV.default;",
  ].join("");

  const warnings = captureWarnings(() => applyFramelessTitlebarWebviewTransforms(source));

  assert.deepEqual(warnings, [
    "WARN: Could not find application menu browser gate - skipping frameless webview platform patch",
  ]);

  const chromeDrift = [
    "function chrome(e){switch(e){case`win32`:return`application-menu`;case`linux`:return`overlay-v2`;default:return`native`}}",
    "function usesChrome(){return document.documentElement.dataset.codexWindowChrome===`application-menu`}",
  ].join("");
  assert.deepEqual(captureWarnings(() => applyFramelessTitlebarWebviewTransforms(chromeDrift)), [
    "WARN: Could not find Linux window controls chrome mapping - skipping frameless webview chrome patch",
  ]);

  assert.deepEqual(
    captureWarnings(() =>
      applyFramelessTitlebarWebviewTransforms(
        "jsx(slot,{codexLinuxUseWindowControlsSafeArea:shouldReserveControls,side:`end`})",
      )),
    ["WARN: Could not disable the Linux window controls safe area - skipping frameless header padding patch"],
  );
});
