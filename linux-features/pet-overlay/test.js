#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  discoverLinuxFeatureManifests,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  DESCRIPTOR_ID,
  applyPetOverlayPatch,
  mergedPetOverlaySettings,
} = require("./patch.js");

function copyFeatureTo(featuresRoot) {
  const featureDir = path.join(featuresRoot, "pet-overlay");
  fs.mkdirSync(featureDir, { recursive: true });
  for (const name of ["feature.json", "README.md", "patch.js", "launcher-hook.sh"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(featureDir, name));
  }
}

function applyPatchTwice(source, context = {}) {
  const patched = applyPetOverlayPatch(source, context);
  assert.equal(applyPetOverlayPatch(patched, context), patched);
  return patched;
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function currentAvatarOverlayBundleFixture() {
  return [
    "let a=require(`electron`),f=require(`node:child_process`);",
    "var settingsHandlers={\"set-setting\":async({key:e,value:t})=>(this.setSettingValue(e,t),{success:!0})};",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},k2={width:0,height:0},O2={width:276,height:131};",
    "var h2=class{constructor(e,t,n,r){this.cursorSource=e;this.pointerAnchorX=t;this.pointerAnchorY=n;this.displayBounds=r}};",
    "var fV=class{window=null;rendererReady=!1;layout=null;mascotSize=oV;traySize=null;pointerInteractive=!1;mousePassthroughEnabled=!1;windowStagedForNativePresentation=!1;layoutMode=`native`;compositionHost={setOverlayWindow(){},isNativeMaterialAttached(){return!1},getCursorPosition(){return null},updateMascotRect(){}};nativePositionController={clear(){}};",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "isOpen(){let e=this.window;return e!=null&&!e.isDestroyed()&&e.isVisible()&&!this.windowStagedForNativePresentation}",
    "startDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;this.cancelMomentum(),this.suppressNextRendererThrow=!1;let r=this.getLayout(n);this.nativePositionController.clear();let i=null,o=t.pointerScreenX!=null&&t.pointerScreenY!=null?{x:t.pointerScreenX,y:t.pointerScreenY}:a.screen.getCursorScreenPoint(),s=i??o,c=t.pointerWindowX-r.mascot.left,l=t.pointerWindowY-r.mascot.top;this.dragState=new h2(i==null?`renderer`:`native`,c,l,a.screen.getDisplayNearestPoint(s).bounds)}",
    "setElementSize(e,{elementSizeRevision:t,isTrayVisible:n,mascot:r,nativeCompositionEnabled:a,tray:o}){let i=this.window;i==null||i.isDestroyed()||i.webContents.id!==e||(this.cancelMomentum(),this.layoutMode=n==null?`native`:`legacy`,this.mascotSize=r,this.traySize=o,this.applyLatestElementSizes(i),this.stageWindowForNativePresentation(i),this.showWindowIfReady(i))}",
    "applyLatestElementSizes(e){this.anchor={...this.anchor,width:this.mascotSize.width,height:this.mascotSize.height},this.applyLayout(e)}",
    "async createWindow(e){let t=await this.windowManager.createWindow({title:a.app.getName(),width:zB.width,height:zB.height,appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:process.platform===`linux`?!0:!1,show:!1,initialRoute:rV});return this.window=t,this.compositionHost.setOverlayWindow(t),this.rendererReady=this.windowManager.isWebContentsReady(t.webContents.id),this.displayBounds=null,this.displayId=null,this.dragState=null,this.layout=null,this.mascotSize=oV,this.mousePassthroughEnabled=!1,this.traySize=null,t.on(`closed`,()=>{this.window===t&&(this.cancelMomentum(),this.window=null,this.dragState=null,this.layout=null,this.rendererReady=!1,this.pointerInteractive=!1,this.mousePassthroughEnabled=!1,this.compositionHost.setOverlayWindow(null),this.broadcastOpenState())}),t}",
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1,r=!0,i=null){if(e.isDestroyed())return;let o=this.getLayoutForDisplay(t);this.displayId=t.id,this.layout=o,this.setWindowBounds(e,o.windowBounds,n,r),this.compositionHost.updateMascotRect(o.mascot),this.sendLayoutToRenderer(e,i)}getLayoutForDisplay(e){return UB({anchor:this.anchor,displayBounds:this.layoutMode===`native`?e.workArea:e.bounds,mode:this.layoutMode,mascotSize:this.mascotSize,nativeMaterialAttached:this.compositionHost.isNativeMaterialAttached(),previousPlacement:this.placement,traySize:this.traySize??(this.layoutMode===`native`?k2:O2)})}getLayout(e){if(this.layout??this.applyLayout(e),this.layout==null)throw Error(`Expected avatar overlay layout`);return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;let t=this.isOpen();this.windowStagedForNativePresentation&&=(e.setOpacity(1),!1),e.moveTop(),e.showInactive(),!t&&this.isOpen()&&(this.finishPendingPresentation(),this.broadcastOpenState())}showWindowIfReady(e){!this.rendererReady||this.initialPresentationState!==`ready`||(this.showWindow(e),this.applyPointerInteractivityPolicy())}stageWindowForNativePresentation(e){e.isDestroyed()||this.applyPointerInteractivityPolicy()}broadcastOpenState(){this.windowManager.sendMessageToAllRegisteredWindows({type:`avatar-overlay-open-state-changed`,isOpen:this.isOpen()})}",
    "applyPointerInteractivityPolicy(){return null}cancelMomentum(){}finishPendingPresentation(){}sendLayoutToRenderer(){}setWindowBounds(){}getCurrentDisplay(){return{id:1,bounds:{x:0,y:0,width:1920,height:1080},workArea:{x:0,y:0,width:1920,height:1080}}}};",
    "function L9({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?_ne:vne,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`?{backgroundColor:k9,backgroundMaterial:`mica`}:{backgroundColor:k9,backgroundMaterial:null}}",
  ].join("");
}

function legacyAvatarOverlayBundleFixture() {
  return [
    "let n=require(`electron`);",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},sV={width:276,height:131};",
    "var fV=class{window=null;anchor={x:0,y:0,width:112,height:121};dragState=null;layout=null;mascotSize=oV;placement=`top-end`;traySize=null;",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "async createWindow(e){let t=await this.windowManager.createWindow({appearance:`avatarOverlay`,focusable:process.platform===`linux`?!0:!1,show:!1,initialRoute:rV});return this.window=t,t}",
    "applyLayout(e,t=n.screen.getDisplayNearestPoint(this.anchor).bounds){if(e.isDestroyed())return;let r=UB({anchor:this.anchor,displayBounds:t,mascotSize:this.mascotSize,previousPlacement:this.placement,traySize:this.traySize??sV});this.anchor=r.anchor,this.layout=r,this.placement=r.placement,this.setWindowBounds(e,r.windowBounds),this.sendLayoutToRenderer(e)}getLayout(e){return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;e.moveTop(),e.showInactive(),this.broadcastOpenState()}startDrag(e,t){this.dragState={}}broadcastOpenState(){}sendLayoutToRenderer(){}setWindowBounds(){}};",
  ].join("");
}

function controllerFromPatchedSource(patched, overrides = {}) {
  const context = {
    globalThis: {},
    process: {
      env: {},
      pid: 4242,
      platform: "linux",
      ...overrides.process,
    },
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
    require(moduleName) {
      if (moduleName === "node:child_process") {
        return overrides.childProcess ?? { execFile() {} };
      }
      if (moduleName === "electron") {
        return {
          app: { getName: () => "Codex" },
          screen: {
            getCursorScreenPoint: () => ({ x: 0, y: 0 }),
            getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout: overrides.setTimeout ?? setTimeout,
    UB: overrides.UB ?? (() => ({
      anchor: { x: 10, y: 10, width: 40, height: 40 },
      mascot: { left: 10, top: 10, width: 40, height: 40 },
      placement: "top-end",
      tray: { left: 10, top: 54, width: 276, height: 131 },
      windowBounds: { x: 0, y: 0, width: 356, height: 320 },
    })),
  };
  vm.runInNewContext(`${patched};globalThis.Controller=fV;`, context);
  const controller = new context.globalThis.Controller(
    { isWebContentsReady: () => true, sendMessageToAllRegisteredWindows() {} },
    { set() {} },
  );
  return { context, controller };
}

function runLayout(patched, featureContext) {
  const { context, controller } = controllerFromPatchedSource(patched);
  controller.setWindowBounds = (_window, bounds) => {
    context.bounds = bounds;
  };
  controller.sendLayoutToRenderer = () => {};
  controller.applyLayout(
    { isDestroyed: () => false },
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  );
  assert.ok(featureContext);
  return { context, controller };
}

test("pet-overlay is discoverable and disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-overlay-feature-"));
  try {
    const featuresRoot = path.join(tempDir, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    copyFeatureTo(featuresRoot);
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');

    const manifests = discoverLinuxFeatureManifests({ featuresRoot });
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].id, "pet-overlay");
    assert.equal(manifests[0].manifest.defaultEnabled, false);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["pet-overlay"]}\n');
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [[`feature:pet-overlay:${DESCRIPTOR_ID}`, "main-bundle", "optional"]],
    );
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    assert.deepEqual(
      plan.runtimeHooks.map((hook) => [hook.key, hook.target, hook.mode.toString(8)]),
      [["launcher", ".codex-linux/launcher.d/pet-overlay-gpu-compositing-default.sh", "755"]],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("does not hard-code a default or custom pet", () => {
  const patchSource = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));

  assert.equal(manifest.defaultEnabled, false);
  assert.equal(manifest.entrypoints.patchDescriptors, "./patch.js");
  assert.deepEqual(manifest.runtimeHooks.launcher, {
    source: "launcher-hook.sh",
    name: "gpu-compositing-default.sh",
    mode: "0755",
  });
  assert.match(fs.readFileSync(path.join(__dirname, "launcher-hook.sh"), "utf8"), /GPU_COMPOSITING/);
  assert.doesNotMatch(patchSource, /custom:los|DEFAULT_PET|avatarMenuItems|pets\/los/);
});

test("GPU compositing launcher default preserves an explicit user override", () => {
  const hook = path.join(__dirname, "launcher-hook.sh");
  const run = (value) => spawnSync("bash", [hook], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(value == null ? {} : { CODEX_ELECTRON_DISABLE_GPU_COMPOSITING: value }),
    },
  });

  const defaulted = run(null);
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(defaulted.stdout.trim(), "env CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0");

  for (const value of ["0", "1"]) {
    const explicit = run(value);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.stdout, "", value);
  }
});

test("patches current avatar overlay layout, transparency, and window sync", () => {
  const patched = applyPatchTwice(currentAvatarOverlayBundleFixture());

  assert.match(patched, /codexPetOverlayLayoutForDisplay\(t,this\.getLayoutForDisplay\(t\),e\)/);
  assert.match(patched, /codexPetOverlaySyncWindow\(e,!0\)/);
  assert.match(patched, /title:`Codex Pet Overlay`,width:zB\.width/);
  assert.match(patched, /setVisibleOnAllWorkspaces/);
  assert.match(patched, /setAlwaysOnTop/);
  assert.match(patched, /setSkipTaskbar/);
  assert.match(patched, /t===`avatarOverlay`\?\{backgroundColor:`#00000000`,backgroundMaterial:null\}/);
  assert.equal((patched.match(/codexPetOverlayLayoutForDisplay/g) ?? []).length, 2);
});

test("refreshes only the avatar overlay after the selected pet changes", async () => {
  const patched = applyPatchTwice(currentAvatarOverlayBundleFixture());
  const reloads = [];
  const savedSettings = [];
  const timers = [];
  const context = {
    require(moduleName) {
      if (moduleName === "electron") {
        return {
          BrowserWindow: {
            getAllWindows: () => [
              {
                getTitle: () => "Codex Pet Overlay",
                isDestroyed: () => false,
                webContents: {
                  isDestroyed: () => false,
                  reload: () => reloads.push("overlay"),
                },
              },
              {
                getTitle: () => "Codex",
                isDestroyed: () => false,
                webContents: {
                  isDestroyed: () => false,
                  reload: () => reloads.push("main"),
                },
              },
            ],
          },
        };
      }
      if (moduleName === "node:child_process") {
        return {};
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout(callback) {
      timers.push(callback);
    },
    setSettingValue(key, value) {
      savedSettings.push([key, value]);
    },
  };
  vm.runInNewContext(`${patched};globalThis.settingsHandlers=settingsHandlers;`, context);

  await context.settingsHandlers["set-setting"]({ key: "theme", value: "dark" });
  assert.deepEqual(reloads, []);
  assert.deepEqual(timers, []);

  await context.settingsHandlers["set-setting"]({ key: "selected-avatar-id", value: "cat" });
  assert.deepEqual(savedSettings, [
    ["theme", "dark"],
    ["selected-avatar-id", "cat"],
  ]);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(reloads, ["overlay"]);
  assert.match(patched, /===`selected-avatar-id`&&codexPetOverlayRefreshAvatarWindows\(\)/);
});

test("discards the feature patch when the current settings handler drifts", () => {
  const source = currentAvatarOverlayBundleFixture().replace(
    '"set-setting":async({key:e,value:t})=>(this.setSettingValue(e,t),{success:!0})',
    '"set-setting":async({key:e,value:t})=>this.setSettingValue(e,t)',
  );
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));

  assert.equal(result, source);
  assert.match(warnings.join("\n"), /Could not find desktop set-setting handler/);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
});

test("does not retain an obsolete avatar overlay layout fallback", () => {
  const source = legacyAvatarOverlayBundleFixture();
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));

  assert.equal(result, source);
  assert.match(warnings.join("\n"), /Could not identify avatar overlay layout variable/);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
});

test("discards every change when a required current hook drifts", () => {
  const source = currentAvatarOverlayBundleFixture().replace(
    "e.moveTop(),e.showInactive(),",
    "e.showInactive(),",
  );
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));

  assert.equal(result, source);
  assert.match(warnings.join("\n"), /Could not identify avatar overlay showWindow display point/);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
});

test("passive mode fails closed when the current create-window shape drifts", () => {
  const source = currentAvatarOverlayBundleFixture().replace(
    "appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:process.platform===`linux`?!0:!1",
    "appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:canFocus",
  );
  const context = {
    feature: { manifest: { petOverlay: { mode: "passive" } }, settings: {} },
  };
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source, context));

  assert.equal(result, source);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
});

test("lockPosition true pins the mascot to the configured display gravity", () => {
  const context = {
    feature: {
      manifest: { petOverlay: { lockPosition: true, gravity: "bottom-right", margin: 24 } },
      settings: {},
    },
  };
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), context);
  const { context: runtimeContext, controller } = runLayout(patched, context);

  assert.deepEqual(JSON.parse(JSON.stringify(runtimeContext.bounds)), {
    x: 1540,
    y: 736,
    width: 356,
    height: 320,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(controller.layout.mascot)), {
    left: 316,
    top: 280,
    width: 40,
    height: 40,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(controller.layout.tray)), {
    left: 80,
    top: 145,
    width: 276,
    height: 131,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(controller.layout.anchor)), {
    x: 1856,
    y: 1016,
    width: 40,
    height: 40,
  });
});

test("locked gravity supports every corner on a negative-origin display", () => {
  const expected = {
    "top-left": { x: -1248, y: -168 },
    "top-right": { x: -72, y: -168 },
    "bottom-left": { x: -1248, y: 752 },
    "bottom-right": { x: -72, y: 752 },
  };
  const layout = {
    anchor: { x: 10, y: 10, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: { left: 10, top: 54, width: 276, height: 131 },
    windowBounds: { x: 0, y: 0, width: 356, height: 320 },
  };

  for (const [gravity, position] of Object.entries(expected)) {
    const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
      feature: { manifest: { petOverlay: { gravity, lockPosition: true, margin: 32 } }, settings: {} },
    });
    const { controller } = controllerFromPatchedSource(patched);
    const result = controller.codexPetOverlayLayoutForDisplay(
      { workArea: { x: -1280, y: -200, width: 1280, height: 1024 } },
      layout,
      { isDestroyed: () => false },
    );
    assert.deepEqual(
      { x: result.anchor.x, y: result.anchor.y },
      position,
      gravity,
    );
  }
});

test("unlocked mode preserves a visible manual window position when no tray needs re-anchoring", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { lockPosition: false } }, settings: {} },
  });
  const { context, controller } = controllerFromPatchedSource(patched, {
    UB: () => ({
      anchor: { x: 10, y: 10, width: 40, height: 40 },
      mascot: { left: 10, top: 10, width: 40, height: 40 },
      placement: "top-end",
      tray: null,
      windowBounds: { x: 0, y: 0, width: 356, height: 320 },
    }),
  });
  controller.codexPetOverlayInitialPositionDone = true;
  controller.setWindowBounds = (_window, bounds) => {
    context.bounds = bounds;
  };
  controller.sendLayoutToRenderer = () => {};
  controller.applyLayout(
    {
      getBounds: () => ({ x: 930, y: 410, width: 356, height: 320 }),
      isDestroyed: () => false,
      isVisible: () => true,
    },
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(context.bounds)), { x: 930, y: 410, width: 356, height: 320 });
  assert.equal(controller.codexPetOverlayManualPosition, true);
});

test("unlocked layout does not re-anchor while a drag is active", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);
  let boundsReads = 0;
  controller.dragState = { active: true };
  const layout = {
    anchor: { x: 10, y: 10, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: null,
    windowBounds: { x: 0, y: 0, width: 356, height: 320 },
  };

  const result = controller.codexPetOverlayLayoutForDisplay(
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    layout,
    {
      getBounds() {
        boundsReads += 1;
        return { x: 930, y: 410, width: 356, height: 320 };
      },
      isVisible: () => true,
    },
  );

  assert.equal(boundsReads, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.windowBounds)), layout.windowBounds);
});

test("syncs overlay window hints without requiring Hyprland", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const calls = [];
  const handlers = {};
  const timers = [];
  const { controller } = controllerFromPatchedSource(patched, {
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
  });
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    focus: () => calls.push("focus"),
    moveTop: () => calls.push("moveTop"),
    setAlwaysOnTop: (value) => calls.push(["always", value]),
    setBackgroundColor: (value) => calls.push(["background", value]),
    setFocusable: (value) => calls.push(["focusable", value]),
    setOpacity: (value) => calls.push(["opacity", value]),
    setSkipTaskbar: (value) => calls.push(["skip", value]),
    setTitle: (value) => calls.push(["title", value]),
    setVisibleOnAllWorkspaces: (value, options) => calls.push(["workspaces", value, options.visibleOnFullScreen]),
    show: () => calls.push("show"),
    showInactive: () => calls.push("showInactive"),
    webContents: {
      executeJavaScript: (script) => calls.push(["js", script]),
      insertCSS: (css, options) => calls.push(["css", css, options]),
      isDestroyed: () => false,
      on: (event, handler) => {
        handlers[event] = handler;
        calls.push(["on", event]);
      },
    },
  };
  controller.window = window;
  controller.showWindow(window);

  assert.deepEqual(calls.slice(0, 5), [
    ["title", "Codex Pet Overlay"],
    ["focusable", false],
    ["skip", true],
    ["always", true],
    ["background", "#00000000"],
  ]);
  assert.deepEqual(calls[5], ["on", "did-finish-load"]);
  assert.equal(calls[6][0], "css");
  assert.equal(calls[6][2].cssOrigin, "author");
  assert.equal(calls[7][0], "js");
  assert.match(calls[6][1], /background:transparent!important/);
  assert.match(calls[7][1], /document\.documentElement\.style\.background/);
  assert.deepEqual(calls.slice(8), [["opacity", 1], ["workspaces", true, true], "moveTop", "showInactive"]);
  assert.deepEqual(timers.map((timer) => timer.delay), [0]);
  assert.equal(calls.includes("focus"), false);
  assert.equal(calls.includes("show"), false);

  timers[0].callback();
  assert.deepEqual(calls.at(-1), ["focusable", true]);

  handlers["did-finish-load"]();
  assert.equal(calls.filter(([kind]) => kind === "css").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "js").length, 2);
});

test("passive mode makes the overlay non-focusable", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { mode: "passive" } }, settings: {} },
  });

  assert.match(
    patched,
    /appearance:`avatarOverlay`,alwaysOnTop:process\.platform===`linux`,skipTaskbar:process\.platform===`linux`,focusable:!1/,
  );
});

test("interactive Niri show releases initial focus before restoring inline reply focusability", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const calls = [];
  const timers = [];
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "niri" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(["niri", args]);
        callback?.(null, "[]");
      },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
  });
  const window = {
    focus: () => calls.push("focus"),
    isDestroyed: () => false,
    isVisible: () => true,
    moveTop: () => calls.push("moveTop"),
    setAlwaysOnTop: (value) => calls.push(["always", value]),
    setBackgroundColor: (value) => calls.push(["background", value]),
    setFocusable: (value) => calls.push(["focusable", value]),
    setOpacity: (value) => calls.push(["opacity", value]),
    setSkipTaskbar: (value) => calls.push(["skip", value]),
    setTitle: (value) => calls.push(["title", value]),
    setVisibleOnAllWorkspaces: (value, options) => calls.push(["workspaces", value, options.visibleOnFullScreen]),
    show: () => calls.push("show"),
    showInactive: () => calls.push("showInactive"),
  };
  controller.window = window;

  controller.showWindow(window);

  assert.deepEqual(timers.map((timer) => timer.delay), [0, 0, 80, 300, 1000]);
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "focusable"), [["focusable", false]]);
  assert.ok(
    calls.findIndex((call) => Array.isArray(call) && call[0] === "focusable" && call[1] === false) <
      calls.indexOf("showInactive"),
  );
  assert.equal(calls.includes("focus"), false);
  assert.equal(calls.includes("show"), false);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "niri"), false);

  timers[0].callback();
  assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === "focusable"), [
    ["focusable", false],
    ["focusable", true],
  ]);
});

test("disabled window hints are actively applied as false", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: {
      manifest: {
        petOverlay: {
          allWorkspaces: false,
          alwaysOnTop: false,
          mode: "passive",
          skipTaskbar: false,
        },
      },
      settings: {},
    },
  });
  const calls = [];
  const { controller } = controllerFromPatchedSource(patched);
  const window = {
    isDestroyed: () => false,
    moveTop: () => calls.push("moveTop"),
    setAlwaysOnTop: (value) => calls.push(["always", value]),
    setFocusable: (value) => calls.push(["focusable", value]),
    setSkipTaskbar: (value) => calls.push(["skip", value]),
    setVisibleOnAllWorkspaces: (value, options) => calls.push(["workspaces", value, options.visibleOnFullScreen]),
  };
  controller.window = window;

  controller.codexPetOverlaySyncWindow(window);

  assert.deepEqual(calls, [
    ["focusable", false],
    ["skip", false],
    ["always", false],
    ["workspaces", false, false],
  ]);
});

test("runtime lock override blocks drag start", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { CODEX_PET_OVERLAY_LOCK_POSITION: "1" } },
  });
  controller.window = { isDestroyed: () => false, webContents: { id: 1 } };
  controller.getLayout = () => ({ mascot: { left: 0, top: 0 } });
  controller.dragState = { preserved: true };

  controller.startDrag(1, {
    pointerScreenX: 100,
    pointerScreenY: 100,
    pointerWindowX: 20,
    pointerWindowY: 20,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(controller.dragState)), { preserved: true });
});

test("runtime unlock override permits drag on a locked build", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { lockPosition: true } }, settings: {} },
  });
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { CODEX_PET_OVERLAY_LOCK_POSITION: "0" } },
  });
  controller.window = { isDestroyed: () => false, webContents: { id: 1 } };
  controller.getLayout = () => ({ mascot: { left: 0, top: 0 } });

  controller.startDrag(1, {
    pointerScreenX: 100,
    pointerScreenY: 100,
    pointerWindowX: 20,
    pointerWindowY: 20,
  });

  assert.notEqual(controller.dragState, null);
});

test("changed locked bounds reschedule Hyprland hints once per change", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { lockPosition: true } }, settings: {} },
  });
  const { controller } = controllerFromPatchedSource(patched);
  const window = { isDestroyed: () => false };
  const scheduled = [];
  const layout = {
    anchor: { x: 10, y: 10, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: { left: 10, top: 54, width: 276, height: 131 },
    windowBounds: { x: 0, y: 0, width: 356, height: 320 },
  };
  controller.window = window;
  controller.codexPetOverlayScheduleHyprlandHints = (target) => scheduled.push(target);

  controller.codexPetOverlayLayoutForDisplay({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }, layout, window);
  controller.codexPetOverlayLayoutForDisplay({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }, layout, window);
  controller.codexPetOverlayLayoutForDisplay({ workArea: { x: 1200, y: 0, width: 1200, height: 800 } }, layout, window);

  assert.deepEqual(scheduled, [window, window]);
});

function runHyprlandHintScenario({ clientsJson, execError = null, settings = {}, env = { XDG_CURRENT_DESKTOP: "Hyprland" } }) {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { hyprland: true } }, settings },
  });
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env },
    childProcess: {
      execFile(command, args, _options, callback) {
        assert.equal(command, "hyprctl");
        assert.equal(_options.timeout, 1200);
        assert.notEqual(_options.shell, true);
        calls.push(args);
        if (args[0] === "clients") {
          callback(execError, clientsJson);
          return;
        }
        callback?.(null, "ok");
      },
    },
  });

  const window = {
    getBounds: () => ({ x: 1540, y: 736, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = window;
  controller.codexPetOverlayApplyHyprlandHints(window);

  return calls;
}

function runNiriHintScenario({
  windowsJson,
  execError = null,
  settings = {},
  env = { XDG_CURRENT_DESKTOP: "niri" },
  desiredDisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 },
  desiredWindowBounds = { x: 1540, y: 736, width: 356, height: 320 },
  windowBounds = desiredWindowBounds,
}) {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { niri: true } }, settings },
  });
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env },
    childProcess: {
      execFile(command, args, _options, callback) {
        assert.equal(command, "niri");
        assert.equal(_options.timeout, 1200);
        assert.notEqual(_options.shell, true);
        calls.push(args);
        if (JSON.stringify(args) === JSON.stringify(["msg", "--json", "windows"])) {
          callback(execError, windowsJson);
          return;
        }
        callback?.(null, "ok");
      },
    },
  });

  const window = {
    getBounds: () => windowBounds,
    isDestroyed: () => false,
  };
  controller.window = window;
  controller.codexPetOverlayDesiredWindowBounds = desiredWindowBounds;
  controller.codexPetOverlayDesiredDisplayBounds = desiredDisplayBounds;
  controller.codexPetOverlayApplyNiriHints(window);

  return calls;
}

test("targets only the unambiguous Hyprland pet window address", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x100",
        at: [0, 0],
        class: "Codex",
        floating: false,
        fullscreen: 0,
        pid: 4242,
        pinned: false,
        size: [1920, 1080],
        title: "Codex",
      },
      {
        address: "0x200",
        at: [1540, 736],
        class: "Codex",
        floating: true,
        fullscreen: 0,
        pid: 4242,
        pinned: false,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.equal(JSON.stringify(calls[0]), JSON.stringify(["clients", "-j"]));
  assert.ok(calls.some((args) => args.join(" ").includes('hl.dsp.window.pin({ action = "on", window = "address:0x200" })')));
  assert.ok(calls.some((args) => args.join(" ").includes('prop = "decorate", value = "0", window = "address:0x200"')));
  assert.ok(calls.some((args) => args.join(" ").includes('prop = "no_shadow", value = "1", window = "address:0x200"')));
  assert.ok(calls.some((args) => args.join(" ").includes('hl.dsp.window.alter_zorder({ mode = "top", window = "address:0x200" })')));
  assert.ok(calls.every((args) => !args.join(" ").includes("0x100")));
});

test("Hyprland matching rejects foreign processes and malformed addresses", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x999",
        at: [1540, 736],
        floating: true,
        fullscreen: 0,
        pid: 9999,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
      {
        address: "$(not-safe)",
        at: [1540, 736],
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
      {
        address: `0x${"a".repeat(128)}`,
        at: [1540, 736],
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("Hyprland matching uses a unique size when coordinate systems disagree", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x201",
        at: [1540, 736],
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [640, 480],
        title: "Codex Pet Overlay",
      },
      {
        address: "0x202",
        at: [-900, -700],
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.ok(calls.some((args) => args.join(" ").includes("address:0x202")));
  assert.ok(calls.every((args) => !args.join(" ").includes("address:0x201")));
});

test("locked Hyprland overlays move to the final desired bounds", () => {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { lockPosition: true } }, settings: {} },
  });
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "Hyprland" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        if (args[0] === "clients") {
          callback(null, JSON.stringify([{
            address: "0xbee",
            at: [0, 0],
            floating: true,
            fullscreen: 0,
            pid: 4242,
            size: [356, 320],
            title: "Codex Pet Overlay",
          }]));
          return;
        }
        callback(null, "ok");
      },
    },
  });
  const window = {
    getBounds: () => ({ x: 0, y: 0, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = window;
  controller.codexPetOverlayDesiredWindowBounds = { x: -179, y: -134, width: 356, height: 320 };

  controller.codexPetOverlayApplyHyprlandHints(window);

  assert.ok(calls.some((args) =>
    args[0] === "dispatch" &&
    args[1].includes("hl.dsp.window.move") &&
    args[1].includes("x = -179") &&
    args[1].includes("y = -134") &&
    args[1].includes("address:0xbee")
  ));
});

test("legacy Hyprland fallbacks keep dispatcher arguments grouped", () => {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { lockPosition: true } }, settings: {} },
  });
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "Hyprland" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        if (args[0] === "clients") {
          callback(null, JSON.stringify([{
            address: "0xbee",
            at: [0, 0],
            floating: true,
            fullscreen: 0,
            pid: 4242,
            pinned: false,
            size: [356, 320],
            title: "Codex Pet Overlay",
          }]));
          return;
        }
        if (args[0] === "dispatch" && args[1]?.startsWith("hl.dsp.window.")) {
          callback(new Error("Lua dispatcher unavailable"), "");
          return;
        }
        callback(null, "ok");
      },
    },
  });
  const window = {
    getBounds: () => ({ x: 0, y: 0, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = window;
  controller.codexPetOverlayDesiredWindowBounds = { x: -179, y: -134, width: 356, height: 320 };

  controller.codexPetOverlayApplyHyprlandHints(window);

  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify([
    "dispatch",
    "movewindowpixel",
    "exact -179 -134,address:0xbee",
  ])));
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify([
    "dispatch",
    "alterzorder",
    "top,address:0xbee",
  ])));
});

test("Hyprland Lua strings escape backslashes and quotes", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);

  assert.equal(
    controller.codexPetOverlayLuaString('path\\to"pet'),
    'path\\\\to\\"pet',
  );
});

test("Hyprland callbacks ignore stale overlay windows", () => {
  const calls = [];
  let clientsCallback;
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "Hyprland" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        if (args[0] === "clients") {
          clientsCallback = callback;
        }
      },
    },
  });
  const oldWindow = {
    getBounds: () => ({ x: 100, y: 100, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = oldWindow;
  controller.codexPetOverlayApplyHyprlandHints(oldWindow);
  controller.window = { isDestroyed: () => false };

  clientsCallback(null, JSON.stringify([{
    address: "0x5a1e",
    at: [100, 100],
    floating: true,
    fullscreen: 0,
    pid: 4242,
    size: [356, 320],
    title: "Codex Pet Overlay",
  }]));

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("Hyprland workspace and top-order actions respect disabled settings", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([{
      address: "0x200",
      at: [1540, 736],
      floating: true,
      fullscreen: 0,
      pid: 4242,
      pinned: false,
      size: [356, 320],
      title: "Codex Pet Overlay",
    }]),
    settings: { petOverlay: { allWorkspaces: false, alwaysOnTop: false } },
  });
  const dispatches = calls.filter((args) => args[0] === "dispatch").map((args) => args.join(" "));

  assert.equal(dispatches.some((call) => call.includes("window.pin")), false);
  assert.equal(dispatches.some((call) => call.includes("alter_zorder")), false);
  assert.ok(dispatches.some((call) => call.includes("border_size")));
});

test("hyprctl stops retrying after ENOENT", () => {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "Hyprland" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        const error = new Error("missing hyprctl");
        error.code = "ENOENT";
        callback(error, "");
      },
    },
  });
  const window = {
    getBounds: () => ({ x: 0, y: 0, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = window;

  controller.codexPetOverlayApplyHyprlandHints(window);
  controller.codexPetOverlayApplyHyprlandHints(window);

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("timed-out modern Hyprland dispatch does not run its legacy fallback", () => {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "Hyprland" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        const error = new Error("hyprctl timed out");
        error.killed = true;
        error.signal = "SIGTERM";
        callback(error, "");
      },
    },
  });

  controller.codexPetOverlayHyprlandDispatch(
    'hl.dsp.window.pin({ action = "on", window = "address:0xbee" })',
    ["pin", "address:0xbee"],
  );

  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([[
      "dispatch",
      'hl.dsp.window.pin({ action = "on", window = "address:0xbee" })',
    ]]),
  );
});

test("missing hyprctl does not dispatch compositor mutations", () => {
  const calls = runHyprlandHintScenario({
    execError: new Error("ENOENT"),
    clientsJson: "",
  });

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("invalid Hyprland client JSON does not dispatch compositor mutations", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: "not-json",
  });

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("multiple matching Hyprland clients are treated as ambiguous", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x201",
        at: [1540, 736],
        class: "Codex",
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
      {
        address: "0x202",
        at: [1541, 736],
        class: "Codex",
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("Hyprland no-match result is ignored", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x300",
        at: [10, 10],
        class: "Terminal",
        floating: true,
        fullscreen: 0,
        pid: 9999,
        size: [800, 600],
        title: "Terminal",
      },
    ]),
  });

  assert.equal(JSON.stringify(calls), JSON.stringify([["clients", "-j"]]));
});

test("settings can turn Hyprland handling off", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x200",
        at: [1540, 736],
        class: "Codex",
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
    ]),
    settings: { petOverlay: { hyprland: false } },
  });

  assert.deepEqual(calls, []);
});

test("environment overrides can turn Hyprland handling off", () => {
  const calls = runHyprlandHintScenario({
    clientsJson: JSON.stringify([
      {
        address: "0x200",
        at: [1540, 736],
        class: "Codex",
        floating: true,
        fullscreen: 0,
        pid: 4242,
        size: [356, 320],
        title: "Codex Pet Overlay",
      },
    ]),
    env: { XDG_CURRENT_DESKTOP: "Hyprland", CODEX_PET_OVERLAY_HYPRLAND: "0" },
  });

  assert.deepEqual(calls, []);
});

test("targets a tiled Niri pet window by id and moves it without focus actions", () => {
  const calls = runNiriHintScenario({
    windowsJson: JSON.stringify([
      {
        id: 7,
        is_floating: false,
        layout: { window_size: [1920, 1080] },
        pid: 4242,
        title: "Codex",
      },
      {
        id: 9,
        is_floating: false,
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.equal(JSON.stringify(calls[0]), JSON.stringify(["msg", "--json", "windows"]));
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify([
    "msg",
    "action",
    "move-window-to-floating",
    "--id",
    "9",
  ])));
  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify([
    "msg",
    "action",
    "move-floating-window",
    "--id",
    "9",
    "-x",
    "1540",
    "-y",
    "736",
  ])));
  assert.ok(calls.every((args) => !args.join(" ").includes("focus")));
});

test("Niri move coordinates are output-local to the remembered work area", () => {
  const cases = [
    {
      label: "secondary output",
      desiredDisplayBounds: { x: 1920, y: 40, width: 1600, height: 860 },
      desiredWindowBounds: { x: 2044, y: 84, width: 356, height: 320 },
      expected: ["124", "44"],
    },
    {
      label: "negative-origin output",
      desiredDisplayBounds: { x: -1280, y: -200, width: 1280, height: 900 },
      desiredWindowBounds: { x: -1180, y: -150, width: 356, height: 320 },
      expected: ["100", "50"],
    },
  ];

  for (const { label, desiredDisplayBounds, desiredWindowBounds, expected } of cases) {
    const calls = runNiriHintScenario({
      desiredDisplayBounds,
      desiredWindowBounds,
      windowsJson: JSON.stringify([{
        id: 9,
        is_floating: true,
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      }]),
    });

    assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify([
      "msg",
      "action",
      "move-floating-window",
      "--id",
      "9",
      "-x",
      expected[0],
      "-y",
      expected[1],
    ])), label);
  }
});

test("Niri movement stays fail-closed until a display work area is known", () => {
  const calls = runNiriHintScenario({
    desiredDisplayBounds: null,
    windowsJson: JSON.stringify([{
      id: 9,
      is_floating: false,
      layout: { window_size: [356, 320] },
      pid: 4242,
      title: "Codex Pet Overlay",
    }]),
  });

  assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify([
    "msg",
    "action",
    "move-window-to-floating",
    "--id",
    "9",
  ])));
  assert.equal(calls.some((args) => args.includes("move-floating-window")), false);
});

test("layout remembers the working area used for later Niri local moves", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);
  const layout = {
    anchor: { x: 10, y: 10, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: null,
    windowBounds: { x: 2044, y: 84, width: 356, height: 320 },
  };

  controller.codexPetOverlayLayoutForDisplay(
    { workArea: { x: 1920, y: 40, width: 1600, height: 860 } },
    layout,
    { isDestroyed: () => false },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(controller.codexPetOverlayDesiredDisplayBounds)), {
    x: 1920,
    y: 40,
    width: 1600,
    height: 860,
  });
});

test("Niri matching rejects foreign, malformed, and ambiguous pet candidates", () => {
  const calls = runNiriHintScenario({
    windowsJson: JSON.stringify([
      {
        id: 11,
        is_floating: true,
        layout: { window_size: [356, 320] },
        pid: 9999,
        title: "Codex Pet Overlay",
      },
      {
        id: "not-safe",
        is_floating: true,
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      },
      {
        id: "13",
        is_floating: true,
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      },
      {
        id: 14,
        is_floating: true,
        layout: { window_size: [356, 320] },
        pid: "4242",
        title: "Codex Pet Overlay",
      },
      {
        id: 12,
        is_floating: "yes",
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.equal(JSON.stringify(calls), JSON.stringify([["msg", "--json", "windows"]]));

  const ambiguousCalls = runNiriHintScenario({
    windowsJson: JSON.stringify([
      {
        id: 21,
        is_floating: true,
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      },
      {
        id: 22,
        is_floating: false,
        layout: { window_size: [356, 320] },
        pid: 4242,
        title: "Codex Pet Overlay",
      },
    ]),
  });

  assert.equal(JSON.stringify(ambiguousCalls), JSON.stringify([["msg", "--json", "windows"]]));
});

test("Niri callbacks ignore stale overlay windows", () => {
  const calls = [];
  let windowsCallback;
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "niri" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        if (JSON.stringify(args) === JSON.stringify(["msg", "--json", "windows"])) {
          windowsCallback = callback;
        }
      },
    },
  });
  const oldWindow = {
    getBounds: () => ({ x: 100, y: 100, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = oldWindow;
  controller.codexPetOverlayDesiredWindowBounds = { x: 100, y: 100, width: 356, height: 320 };
  controller.codexPetOverlayApplyNiriHints(oldWindow);
  controller.window = { isDestroyed: () => false };

  windowsCallback(null, JSON.stringify([{
    id: 42,
    is_floating: false,
    layout: { window_size: [356, 320] },
    pid: 4242,
    title: "Codex Pet Overlay",
  }]));

  assert.equal(JSON.stringify(calls), JSON.stringify([["msg", "--json", "windows"]]));
});

test("missing niri does not keep spawning compositor probes", () => {
  const calls = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "niri" } },
    childProcess: {
      execFile(_command, args, _options, callback) {
        calls.push(args);
        const error = new Error("missing niri");
        error.code = "ENOENT";
        callback(error, "");
      },
    },
  });
  const window = {
    getBounds: () => ({ x: 0, y: 0, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  controller.window = window;

  controller.codexPetOverlayApplyNiriHints(window);
  controller.codexPetOverlayApplyNiriHints(window);

  assert.equal(JSON.stringify(calls), JSON.stringify([["msg", "--json", "windows"]]));
});

test("settings and environment can turn Niri handling off", () => {
  const settingsCalls = runNiriHintScenario({
    windowsJson: JSON.stringify([{
      id: 9,
      is_floating: true,
      layout: { window_size: [356, 320] },
      pid: 4242,
      title: "Codex Pet Overlay",
    }]),
    settings: { petOverlay: { niri: false } },
  });
  const envCalls = runNiriHintScenario({
    windowsJson: JSON.stringify([{
      id: 9,
      is_floating: true,
      layout: { window_size: [356, 320] },
      pid: 4242,
      title: "Codex Pet Overlay",
    }]),
    env: { XDG_CURRENT_DESKTOP: "niri", CODEX_PET_OVERLAY_NIRI: "0" },
  });

  assert.deepEqual(settingsCalls, []);
  assert.deepEqual(envCalls, []);
});

test("Niri scheduling is coalesced when desired bounds change repeatedly", () => {
  const timers = [];
  const cleared = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "niri" } },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      cleared.push(timer);
    },
  });
  const window = { isDestroyed: () => false };

  controller.codexPetOverlayScheduleNiriHints(window);
  controller.codexPetOverlayScheduleNiriHints(window);

  assert.deepEqual(timers.map((timer) => timer.delay), [0, 80, 300, 1000, 0, 80, 300, 1000]);
  assert.deepEqual(cleared, timers.slice(0, 4));
});

test("settings validation falls back to safe defaults", () => {
  assert.deepEqual(
    mergedPetOverlaySettings({
      feature: {
        manifest: { petOverlay: { gravity: "bottom-right", margin: 24, mode: "interactive" } },
        settings: { petOverlay: { gravity: "middle", margin: 9999, mode: "unknown", lockPosition: true } },
      },
    }),
    {
      allWorkspaces: true,
      alwaysOnTop: true,
      gravity: "bottom-right",
      hyprland: true,
      lockPosition: true,
      margin: 512,
      mode: "interactive",
      niri: true,
      skipTaskbar: true,
    },
  );
});
