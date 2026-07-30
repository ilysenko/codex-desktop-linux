"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyMainBundlePatchDescriptors,
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("./engine.js");
const {
  corePatchDescriptors,
  featurePatchDescriptors,
} = require("./runner.js");
const {
  createPatchReport,
  criticalFailuresFromReport,
  optionalDriftFromReport,
} = require("../lib/patch-report.js");

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("current main-process feature composition is byte-identical on a second pass", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-main-feature-composition-"),
  );
  try {
    const featuresConfigPath = path.join(tempRoot, "features.json");
    fs.writeFileSync(
      featuresConfigPath,
      JSON.stringify({ enabled: ["record-and-replay", "frameless-titlebar"] }),
    );
    const descriptorIds = new Set([
      "linux-native-titlebar",
      "feature:record-and-replay:linux-record-replay-main-bridge",
      "linux-external-open-env",
      "feature:frameless-titlebar:main-process",
    ]);
    const descriptors = normalizePatchDescriptors([
      ...corePatchDescriptors(),
      ...featurePatchDescriptors({ featuresConfigPath }),
    ].filter(({ id }) => descriptorIds.has(id)));
    assert.deepEqual(
      descriptors.map(({ id }) => id),
      [
        "linux-native-titlebar",
        "feature:record-and-replay:linux-record-replay-main-bridge",
        "linux-external-open-env",
        "feature:frameless-titlebar:main-process",
      ],
    );

    const source = [
      "\"use strict\";let c=require(`electron`),d=require(`electron`);",
      "function A9(e){return e===`avatarOverlay`}",
      "function I9({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A9(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?L9:K9,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A9(t)?{backgroundColor:r?L9:K9,backgroundMaterial:null}:{backgroundColor:W9,backgroundMaterial:null}}",
      "function j9(e=1){return{color:W9,symbolColor:c.nativeTheme.shouldUseDarkColors?i9:r9,height:Math.round(g9*e)}}",
      "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:A9(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
      "setWindowZoom(e,t){let n=c.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);n==null||r!==`primary`&&r!==`quickChat`||(process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t))))}",
      "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(j9(this.windowZooms.get(e.id)))};return c.nativeTheme.on(`updated`,n),n(),()=>{c.nativeTheme.off(`updated`,n)}}",
      "var tray={getChronicleSidecarControlState:()=>tt().skysight?$9:Se.appServerConnectionRegistry.getMaybeConnection(`local`)?.getChronicleSidecarControlState()??$9,toggleChronicleSidecar:async()=>{if(tt().skysight)return $9;let e=Se.appServerConnectionRegistry.getMaybeConnection(V);return e==null?$9:e.getChronicleSidecarControlState().running?e.pauseChronicleSidecar():e.resumeChronicleSidecar()}};",
      "var bridge={\"get-global-state\":async({key:e})=>null};",
      "async function openExternal(url,options){return c.shell.openExternal(url,options)}",
    ].join("");
    const context = { iconAsset: null };
    const firstReport = createPatchReport();
    const first = captureWarns(() =>
      applyMainBundlePatchDescriptors(
        source,
        descriptors,
        context,
        firstReport,
      ),
    );

    assert.notEqual(first.value.patchedSource, source);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(first.value.warnings, []);
    assert.deepEqual(
      firstReport.patches.map(({ name, status }) => ({ name, status })),
      descriptors.map(({ id }) => ({ name: id, status: "applied" })),
    );

    const secondReport = createPatchReport();
    const second = captureWarns(() =>
      applyMainBundlePatchDescriptors(
        first.value.patchedSource,
        descriptors,
        context,
        secondReport,
      ),
    );

    assert.equal(second.value.patchedSource, first.value.patchedSource);
    assert.deepEqual(second.warnings, []);
    assert.deepEqual(second.value.warnings, []);
    assert.deepEqual(
      secondReport.patches.map(({ name, status }) => ({ name, status })),
      descriptors.map(({ id }) => ({
        name: id,
        status: "already-applied",
      })),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("native titlebar report rejects a preserved marker with a restored Linux zoom consumer", () => {
  const descriptor = corePatchDescriptors().find(
    ({ id }) => id === "linux-native-titlebar",
  );
  const source = [
    "function A9(e){return e===`avatarOverlay`}",
    "function I9({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A9(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?L9:K9,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A9(t)?{backgroundColor:r?L9:K9,backgroundMaterial:null}:{backgroundColor:W9,backgroundMaterial:null}}",
    "function j9(e=1){return{color:W9,symbolColor:c.nativeTheme.shouldUseDarkColors?i9:r9,height:Math.round(g9*e)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:A9(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:j9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "setWindowZoom(e,t){let n=c.BrowserWindow.fromWebContents(e),r=n&&this.windowAppearances.get(n.id);n==null||r!==`primary`&&r!==`quickChat`||(process.platform===`darwin`?n.setWindowButtonPosition(A9(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(j9(t))))}",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(j9(this.windowZooms.get(e.id)))};return c.nativeTheme.on(`updated`,n),n(),()=>{c.nativeTheme.off(`updated`,n)}}",
  ].join("");
  const firstReport = createPatchReport();
  const first = applyMainBundlePatchDescriptors(
    source,
    [descriptor],
    {},
    firstReport,
  ).patchedSource;
  const damaged = first.replace(
    "n.setTitleBarOverlay(process.platform===`linux`?codexLinuxTitleBarOverlay(t):j9(t))",
    "n.setTitleBarOverlay(j9(t))",
  );
  assert.notEqual(damaged, first);

  const secondReport = createPatchReport();
  const { warnings } = captureWarns(() =>
    applyMainBundlePatchDescriptors(
      damaged,
      [descriptor],
      {},
      secondReport,
    ),
  );

  assert.equal(
    secondReport.patches[0]?.status,
    "failed-required",
  );
  assert.equal(
    criticalFailuresFromReport(secondReport)[0]?.name,
    "linux-native-titlebar",
  );
  assert.match(warnings[0] ?? "", /incomplete Linux native titlebar patch/);
});

test("window controls safe-area report rejects a preserved marker with damaged consumers", () => {
  const descriptor = corePatchDescriptors().find(
    ({ id }) => id === "linux-window-controls-safe-area",
  );
  const source = [
    "var l=Object.freeze({default:Object.freeze({left:0,right:0}),applicationMenu:Object.freeze({left:0,right:0})});",
    "function ol({isHeaderEdgeScroll:e,isApplicationMenuBarEnabled:t}){return (0,gl.jsxs)(ue.header,{children:[(0,gl.jsx)(sl,{entries:m,fitWidth:n,slotWidth:c,side:`start`}),(0,gl.jsx)(sl,{entries:h,fitWidth:r,slotWidth:u,side:`end`})]})}",
    "function sl({entries:e,fitWidth:t,side:n,slotWidth:r}){let i=e.some(({align:e})=>e===`end`),o=a({\"pe-2\":n===`start`&&i||n===`end`});return jsx(o)}",
  ].join("");
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-safe-area-composition-"),
  );
  try {
    const assetsDir = path.join(tempRoot, "webview", "assets");
    const assetPath = path.join(assetsDir, "app-initial-current.js");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(assetPath, source);

    const firstReport = createPatchReport();
    applyWebviewAssetPatchDescriptors(
      tempRoot,
      [descriptor],
      {},
      firstReport,
    );
    const first = fs.readFileSync(assetPath, "utf8");
    const damagedVariants = [
      first.replace(
        "applicationMenu:Object.freeze({left:0,right:138})",
        "applicationMenu:Object.freeze({left:0,right:0})",
      ),
      first.replace(
        ",codexLinuxUseWindowControlsSafeArea}){",
        "}){",
      ),
      first.replace(
        '"pe-2":n===`start`&&i||n===`end`&&!codexLinuxUseWindowControlsSafeArea,"pe-(--spacing-token-safe-header-right)":n===`end`&&codexLinuxUseWindowControlsSafeArea',
        '"pe-2":n===`start`&&i||n===`end`',
      ),
    ];

    for (const damaged of damagedVariants) {
      assert.notEqual(damaged, first);
      fs.writeFileSync(assetPath, damaged);

      const secondReport = createPatchReport();
      const { warnings } = captureWarns(() =>
        applyWebviewAssetPatchDescriptors(
          tempRoot,
          [descriptor],
          {},
          secondReport,
        ),
      );

      assert.equal(
        secondReport.patches[0]?.status,
        "skipped-optional",
      );
      assert.equal(
        optionalDriftFromReport(secondReport)[0]?.name,
        "linux-window-controls-safe-area",
      );
      assert.match(
        warnings[0] ?? "",
        /incomplete Linux window-controls safe-area patch/,
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("external-open report rejects a preserved helper with one restored core target", () => {
  const descriptor = corePatchDescriptors().find(
    ({ id }) => id === "linux-external-open-env",
  );
  const source =
    '"use strict";let e=require("electron"),t=require("electron");';
  const firstReport = createPatchReport();
  const first = applyMainBundlePatchDescriptors(
    source,
    [descriptor],
    {},
    firstReport,
  ).patchedSource;
  const damaged = first.replace(
    "/*codexLinuxExternalOpenTarget*/codexLinuxPatchExternalOpen(require(\"electron\"))",
    'require("electron")',
  );
  assert.notEqual(damaged, first);

  const secondReport = createPatchReport();
  const { warnings } = captureWarns(() =>
    applyMainBundlePatchDescriptors(
      damaged,
      [descriptor],
      {},
      secondReport,
    ),
  );

  assert.equal(
    secondReport.patches[0]?.status,
    "skipped-optional",
  );
  assert.equal(
    optionalDriftFromReport(secondReport)[0]?.name,
    "linux-external-open-env",
  );
  assert.match(
    warnings[0] ?? "",
    /incomplete Linux external open environment patch/,
  );
});
