#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  applyLinuxAppshotSettingsHotkeyPatch,
  descriptors,
  findMessageForViewSendFunction,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function appshotAvailabilityAtomBundleFixture() {
  return [
    "import{c as e,l as t,t as n}from\"./app-scope.js\";",
    "import{v as r}from\"./app-server-manager-signals.js\";",
    "import{f as i}from\"./statsig.js\";",
    "import{n as a}from\"./platform.js\";",
    "import{c as o}from\"./config-queries.js\";",
    "var s=t(n,(e,{get:t})=>{if(t(a)!==`macOS`||!t(i,`1304276663`))return!1;let{data:n}=t(o,{hostId:e});return n!=null&&n.requirements?.allowAppshots!==!1}),c=e(n,({get:e})=>e(s,e(r)));export{s as n,c as t};",
  ].join("");
}

function appshotMainProcessBundleFixture() {
  return [
    "var Ts=`codex_desktop:message-from-view`,F=`codex_desktop:message-for-view`,eS=new Map;",
    "function tS({origin:n,requestId:r,subscribeComputerUseCaptureWorkerEvent:a}){let l=a(`update`,e=>{e.requestId===r&&nS(e.requestId,e.update)});eS.set(r,{origin:n,unsubscribe:l})}",
    "function nS(e,t){let n=eS.get(e);n!=null&&(rS(n.origin,{requestId:e,type:`computer-use-capture-updated`,update:t}),(t.type===`completed`||t.type===`failed`)&&iS(e,n))}",
    "function rS(e,t){e.isDestroyed()||e.send(F,t)}",
    "\"computer-use-frontmost-window\":async()=>process.platform===`darwin`?Xo():null,",
    "\"computer-use-start-capture\":async({animationDestination:e,bundleIdentifier:t,origin:n,requestId:r})=>{if(process.platform!==`darwin`||this.requestComputerUseCaptureWorker==null||this.subscribeComputerUseCaptureWorkerEvent==null)return null;let i=GO({backgroundColor:e.backgroundColor,cornerRadius:e.cornerRadius,primaryTextColor:e.primaryTextColor,viewportFrame:e.viewportFrame,webContents:n});return i==null?null:eS({animationTarget:i,bundleIdentifier:t,origin:n,requestComputerUseCaptureWorker:this.requestComputerUseCaptureWorker,requestId:r,subscribeComputerUseCaptureWorkerEvent:this.subscribeComputerUseCaptureWorkerEvent})}",
  ].join("");
}

function appshotHotkeyMainBundleFixture() {
  return [
    "var uG=`DoubleCommand`,dG=6e4;",
    "function rw(e,t=process.platform){return t===`darwin`&&aw(e)!=null}",
    "function QC(e,t,r=`press`){if(process.platform!==`darwin`)return null;let i=aw(e);return i==null?null:KC(e,t,r)}",
    "function bw(e,t,r){if(iw(e))return rw(e)?QC(e,t,r?.bareModifierTrigger):null;let i=Ew(e),a=()=>{t.onPressed()},o=n.globalShortcut.register(i,a);return o?{handlesRelease:!1,unregister:()=>{n.globalShortcut.unregister(i)}}:null}",
    "function fG({globalState:e,windowManager:n,enabled:r}){let i=e.get(`appshotHotkey`)??uG,a=null,o=()=>({supported:r&&process.platform===`darwin`,configuredHotkey:i,isActive:a!=null}),s=()=>{if(a?.unregister(),a=null,!r||process.platform!==`darwin`||i==null){t.$r().info(`Appshot hotkey inactive`,{safe:{enabled:r,platform:process.platform,configured:i!=null},sensitive:{}});return}if(t.$r().info(`Registering appshot hotkey`,{safe:{hotkey:i},sensitive:{}}),Cw(i,{bareModifierTrigger:`immediatePress`}),a=bw(i,{onPressed:()=>{t.$r().info(`Appshot hotkey pressed`,{safe:{hotkey:i},sensitive:{}});let e=n.getPrimaryWindow();if(e==null||e.isDestroyed()){return}let r=n.wasPrimaryWindowFocusedWithin(e,dG);r||n.sendMessageToWindow(e,{type:`navigate-to-route`,path:`/`,state:{focusComposerNonce:Date.now()}}),n.sendMessageToWindow(e,{type:`appshot-shortcut`})}},{bareModifierTrigger:`immediatePress`}),a==null)throw Error(`Unable to register shortcut: ${i}`);t.$r().info(`Registered appshot hotkey`,{safe:{hotkey:i},sensitive:{}})},c=n=>{if(!r||process.platform!==`darwin`)return{success:!1,error:`Not supported.`,state:o()};if(n!=null){let e=Sw(n);if(e!=null)return{success:!1,error:e,state:o()}}let a=i;i=n;try{s()}catch(e){i=a;return{success:!1,error:e instanceof Error?e.message:String(e),state:o()}}return e.set(`appshotHotkey`,i??void 0),{success:!0,state:o()}};try{s()}catch(e){}return{getState:o,setHotkey:c,dispose:()=>{a?.unregister(),a=null}}}",
  ].join("");
}

function appshotHotkeyStoredMainBundleFixture() {
  return [
    "var bX=`DoubleCommand`,xX=6e4;",
    "function CE(e,t=process.platform){return t===`darwin`&&TE(e)!=null}",
    "function vE(e,t,n=`press`){if(process.platform!==`darwin`)return null;let r=TE(e);return r==null?null:DE(r,t,n)}",
    "function HE(e,t=process.platform){let n=GE(e);if(CE(e,t))return null;if(n.some(wE))return n.length===1?t===`darwin`?CE(e,t)?null:`This shortcut key is not supported.`:`Choose a shortcut with Ctrl or Alt plus another key.`:`Use Ctrl, Alt, or Command when combining with another key.`;return null}",
    "function SX({globalState:e,windowManager:n,enabled:r}){let i=e.getStored(`appshotHotkey`),a=i===void 0?bX:i,o=null,s=()=>({supported:r&&process.platform===`darwin`,configuredHotkey:a,isActive:o!=null}),c=()=>{if(o?.unregister(),o=null,!r||process.platform!==`darwin`||a==null){t.Nr().info(`Appshot hotkey inactive`,{safe:{enabled:r,platform:process.platform,configured:a!=null},sensitive:{}});return}if(t.Nr().info(`Registering appshot hotkey`,{safe:{hotkey:a},sensitive:{}}),UE(a,{bareModifierTrigger:`immediatePress`}),o=BE(a,{onPressed:()=>{t.Nr().info(`Appshot hotkey pressed`,{safe:{hotkey:a},sensitive:{}});let e=n.getPrimaryWindow();if(e==null||e.isDestroyed()){return}let r=n.wasPrimaryWindowFocusedWithin(e,xX);r||n.sendMessageToWindow(e,{type:`navigate-to-route`,path:`/`,state:{focusComposerNonce:Date.now()}}),n.sendMessageToWindow(e,{type:`appshot-shortcut`})}},{bareModifierTrigger:`immediatePress`}),o==null)throw Error(`Unable to register shortcut: ${a}`);t.Nr().info(`Registered appshot hotkey`,{safe:{hotkey:a},sensitive:{}})},l=n=>{if(!r||process.platform!==`darwin`&&process.platform!==`linux`)return{success:!1,error:`Not supported.`,state:s()};if(n!=null){let e=HE(n);if(e!=null)return{success:!1,error:e,state:s()}}let i=a;a=n;try{c()}catch(e){a=i;return{success:!1,error:e instanceof Error?e.message:String(e),state:s()}}return e.set(`appshotHotkey`,a),{success:!0,state:s()}};try{c()}catch(e){}return{rpc:{getState:s,setHotkey:l},dispose:()=>{o?.unregister(),o=null}}}",
  ].join("");
}

function appshotSettingsBundleFixture() {
  return [
    "var O=d(),A=e(t(),1),j=n(),M=[{hotkey:`DoubleCommand`,label:`\\u2318 + \\u2318`},{hotkey:`DoubleOption`,label:`\\u2325 + \\u2325`},{hotkey:`DoubleShift`,label:`\\u21e7 + \\u21e7`}];",
    "function N(){let{data:h}=l(`appshot-hotkey-state`,{queryConfig:{enabled:t}}),x=c(`appshot-set-hotkey`);let w=h?.configuredHotkey??null,E=M.find(e=>e.hotkey===w)??null;return E}",
  ].join("");
}

test("appshots stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const featuresRoot = path.resolve(__dirname, "..");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(configPath, '{"enabled":["appshots"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });

    assert.equal(loaded.length, 4);
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id).sort(),
      [
        "feature:appshots:linux-appshots-availability",
        "feature:appshots:linux-appshots-hotkey",
        "feature:appshots:linux-appshots-main-process",
        "feature:appshots:linux-appshots-settings-hotkey",
      ].sort(),
    );
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("appshots feature descriptors are optional", () => {
  assert.equal(descriptors.length, 4);
  assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy == null));
});

test("appshots availability descriptor matches the current bundle", () => {
  const descriptor = descriptors.find(
    (descriptor) => descriptor.id === "linux-appshots-availability",
  );

  assert.ok(descriptor.pattern.test("appshot-availability-BoK-Z77O.js"));
});

test("stages the Linux bare modifier monitor helper", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  const helperSource = fs.readFileSync(
    path.join(__dirname, "bin", "bare-modifier-monitor"),
    "utf8",
  );

  assert.deepEqual(manifest.resources, [
    {
      source: "bin/bare-modifier-monitor",
      target: "resources/native/bare-modifier-monitor",
      mode: "0755",
    },
  ]);
  assert.match(helperSource, /xinput test "\$device_id"/);
  assert.match(helperSource, /stdbuf -oL/);
  assert.match(helperSource, /exec 4<>"\$event_fifo"/);
  assert.match(helperSource, /pkill -TERM -P "\$pid"/);
  assert.match(helperSource, /while read -r pending code <&3; do/);
  assert.match(helperSource, /\) >"\$event_fifo" 2>\/dev\/null &/);
  assert.match(helperSource, /doublealt\|doubleoption\|alt\+alt/);
  assert.match(helperSource, /doubleshift\|shift\+shift\|leftshift\+rightshift/);
  assert.match(helperSource, /Shift_L Shift_R/);
  assert.match(helperSource, /last_tap_code=""/);
  assert.match(helperSource, /\[ "\$code" != "\$last_tap_code" \]/);
  assert.doesNotMatch(helperSource, /while IFS= read -r pending code/);
  assert.doesNotMatch(helperSource, /test-xi2 --root/);
  execFileSync("bash", ["-n", path.join(__dirname, "bin", "bare-modifier-monitor")]);
});

test("enables AppShots availability atom on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotAvailabilityPatch,
    appshotAvailabilityAtomBundleFixture(),
  );

  assert.match(
    patched,
    /if\(t\(a\)!==`linux`&&\(t\(a\)!==`macOS`\|\|!t\(i,`1304276663`\)\)\)return!1;/,
  );
  assert.match(patched, /requirements\?\.allowAppshots!==!1/);
});

test("finds only the raw renderer message sender", () => {
  assert.equal(findMessageForViewSendFunction(appshotMainProcessBundleFixture()), "rS");
  assert.equal(
    findMessageForViewSendFunction("var F=`codex_desktop:message-for-view`;function nS(e,t){}"),
    null,
  );
});

test("routes AppShots capture through the self-contained Linux feature", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotMainProcessPatch,
    appshotMainProcessBundleFixture(),
  );

  assert.match(
    patched,
    /process\.platform===`linux`\?codexLinuxAppshotFrontmostWindow\(\):process\.platform===`darwin`\?Xo\(\):null/,
  );
  assert.match(
    patched,
    /if\(process\.platform===`linux`\)return codexLinuxAppshotStartCapture\(\{origin:n,requestId:r,bundleIdentifier:t\}\);/,
  );
  assert.match(patched, /function codexLinuxAppshotBackendPath/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`windows`\],5000\)/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`state`,e\],10000\)/);
  assert.match(patched, /spectacle.*-b.*-n/);
  assert.match(patched, /programs:\[`spectacle`,`\/usr\/bin\/spectacle`\]/);
  assert.match(patched, /codexLinuxAppshotCropWithImageMagick/);
  assert.ok(
    patched.indexOf("await codexLinuxAppshotCropWithImageMagick") <
      patched.indexOf("codexLinuxAppshotCropNativeImage(o,u,s)"),
  );
  assert.match(patched, /\[linux-appshots\]/);
  assert.match(patched, /codexLinuxAppshotCropRects/);
  assert.match(patched, /codexLinuxAppshotFirstValidCrop/);
  assert.doesNotMatch(patched, /\[`appshot`/);
  assert.doesNotMatch(patched, /bare-modifier-monitor/);
  assert.match(
    patched,
    /function codexLinuxAppshotSend\(e,t,n\)\{try\{rS\(e,\{requestId:t,type:`computer-use-capture-updated`,update:n\}\)\}catch\{\}\}/,
  );
  assert.doesNotMatch(
    patched,
    /function codexLinuxAppshotSend\(e,t,n\)\{try\{nS\(e,\{requestId:t,type:`computer-use-capture-updated`,update:n\}\)\}catch\{\}\}/,
  );
  assert.match(patched, /transitionSnapshotHeight:140/);
  assert.match(patched, /type:`metadata`,app:\{bundleIdentifier:i\.bundleIdentifier/);
  assert.match(patched, /type:`axText`,text:o/);
  assert.match(patched, /type:`screenshot`,screenshotDataURL:s\.dataURL/);
  assert.match(patched, /type:`completed`,transitionSnapshotDataURL:s\.dataURL/);
});

test("enables AppShots hotkeys and bare modifiers on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotHotkeyPatch,
    appshotHotkeyMainBundleFixture(),
  );

  assert.match(
    patched,
    /function rw\(e,t=process\.platform\)\{return \(t===`darwin`\|\|t===`linux`\)&&aw\(e\)!=null\}/,
  );
  assert.match(
    patched,
    /function QC\(e,t,r=`press`\)\{if\(process\.platform!==`darwin`&&process\.platform!==`linux`\)return null;/,
  );
  assert.match(patched, /appshotHotkey`\)\?\?\(process\.platform===`linux`\?null:uG\)/);
  assert.doesNotMatch(patched, /process\.platform===`linux`\?`DoubleShift`/);
  assert.doesNotMatch(patched, /process\.platform===`linux`&&i!=null&&iw\(i\)&&\(i=null\)/);
  assert.match(
    patched,
    /supported:r&&\(process\.platform===`darwin`\|\|process\.platform===`linux`\)/,
  );
  assert.match(
    patched,
    /!r\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\|\|i==null/,
  );
  assert.match(
    patched,
    /if\(!r\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\)return\{success:!1,error:`Not supported\.`,state:o\(\)\}/,
  );
  assert.match(patched, /type:`appshot-shortcut`/);
  assert.doesNotMatch(patched, /bare-modifier-monitor/);
  assert.doesNotMatch(patched, /codexLinuxAppshotBareModifierHotkey/);
  assert.doesNotMatch(patched, /codexLinuxAppshotRegisterBareModifierHotkey/);
});

test("enables Linux AppShots hotkeys for stored upstream controller shape", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotHotkeyPatch,
    appshotHotkeyStoredMainBundleFixture(),
  );

  assert.match(
    patched,
    /function CE\(e,t=process\.platform\)\{return \(t===`darwin`\|\|t===`linux`\)&&TE\(e\)!=null\}/,
  );
  assert.match(
    patched,
    /function vE\(e,t,n=`press`\)\{if\(process\.platform!==`darwin`&&process\.platform!==`linux`\)return null;/,
  );
  assert.match(
    patched,
    /return n\.length===1\?\(t===`darwin`\|\|t===`linux`\)\?CE\(e,t\)\?null:`This shortcut key is not supported\.`:`Choose a shortcut with Ctrl or Alt plus another key\.`:`Use Ctrl, Alt, or Command when combining with another key\.`/,
  );
  assert.match(
    patched,
    /let i=e\.getStored\(`appshotHotkey`\),a=i===void 0\?\(process\.platform===`linux`\?null:bX\):i,o=null/,
  );
  assert.match(
    patched,
    /supported:r&&\(process\.platform===`darwin`\|\|process\.platform===`linux`\)/,
  );
  assert.match(
    patched,
    /!r\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\|\|a==null/,
  );
});

test("shows Linux AppShots accelerator choices in settings", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotSettingsHotkeyPatch,
    appshotSettingsBundleFixture(),
  );

  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /hotkey:`DoubleOption`,label:`Alt \+ Alt`/);
  assert.match(patched, /hotkey:`DoubleShift`,label:`Shift \+ Shift`/);
  assert.match(patched, /hotkey:`Ctrl\+Super\+A`,label:`Ctrl \+ Super \+ A`/);
  assert.doesNotMatch(patched, /hotkey:`Alt\+Super\+A`/);
  assert.doesNotMatch(patched, /hotkey:`Ctrl\+Alt\+A`/);
  assert.match(patched, /hotkey:`DoubleCommand`,label:`\\u2318 \+ \\u2318`/);
  assert.match(patched, /hotkey:`DoubleShift`,label:`\\u21e7 \+ \\u21e7`/);
});
