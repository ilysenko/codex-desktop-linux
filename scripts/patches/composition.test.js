"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyMainBundlePatchDescriptors,
  normalizePatchDescriptors,
} = require("./engine.js");
const {
  corePatchDescriptors,
  featurePatchDescriptors,
} = require("./runner.js");
const { createPatchReport } = require("../lib/patch-report.js");

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
      "\"use strict\";let c=require(`electron`);",
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
