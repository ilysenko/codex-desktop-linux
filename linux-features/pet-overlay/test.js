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
    "let a=require(`electron`),f=require(`node:child_process`),hm=50;function sl(){return!1}function cl(){return!0}function ll(e){return e.getBounds?.()??e.getContentBounds?.()??null}function Cp(e){return e.workArea??e.bounds}function Dm(e,t){return{x:Number(e?.x??0)+Number(t?.x??0),y:Number(e?.y??0)+Number(t?.y??0)}}function sp(){return{shouldDock:!0}}function Vp(e){return e}",
    "var settingsHandlers={\"set-setting\":async({key:e,value:t})=>(this.setSettingValue(e,t),{success:!0})};",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},k2={width:0,height:0},O2={width:276,height:131};",
    "var h2=class{constructor(e,t,n,r){this.cursorSource=e;this.pointerAnchorX=t;this.pointerAnchorY=n;this.displayBounds=r;this.hasMovementIntent=!1;this.hasMoved=!1}getCursorPointForSource({native:e,renderer:t}){return this.cursorSource===`native`?e:t}recordMove(e){this.hasMovementIntent=!0,this.hasMoved=!0,this.displayBounds=e}recordMovementIntent(){this.hasMovementIntent=!0}shouldSuppressRendererThrow(){return!1}};",
    "var fV=class{window=null;rendererReady=!1;layout=null;mascotSize=oV;traySize=null;pointerInteractive=!1;mousePassthroughEnabled=!1;windowStagedForNativePresentation=!1;layoutMode=`native`;nativeWindowDragStart=null;nativeWindowDragActive=!1;nativeWindowDragCompletionTimer=null;nativeWindowDragTargetRegistered=!1;hasDeferredLayout=!1;isQuickChatPresentation=!1;presentationOffset={x:0,y:0};anchor={x:0,y:0,width:112,height:121};compositionHost={setOverlayWindow(){},isNativeMaterialAttached(){return!1},updateMascotRect(){}};nativePositionController={clear(){}};",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "isOpen(){let e=this.window;return e!=null&&!e.isDestroyed()&&e.isVisible()&&!this.windowStagedForNativePresentation}",
    "startDrag(e,t,n=!1){let r=this.window;if(r==null||r.isDestroyed()||r.webContents.id!==e)return;this.nativeWindowDragActive&&this.endDrag(e,void 0,`button-released`),this.cancelMomentum(),this.clearMovedWindowPersist(),this.clearNativeWindowDragCompletionTimer(),this.dockRestoreAnchor=null,this.nativeWindowDragActive=!1,this.suppressNextRendererThrow=!1,this.clearDetachedDisplayRestore();let i=this.getLayout(r),o=t.pointerScreenX!=null&&t.pointerScreenY!=null?{x:t.pointerScreenX,y:t.pointerScreenY}:a.screen.getCursorScreenPoint(),s=t.pointerWindowX-i.mascot.left,c=t.pointerWindowY-i.mascot.top;this.dragState=new h2(`renderer`,s,c,a.screen.getDisplayNearestPoint(o).bounds),this.nativeWindowDragStart=this.layoutMode===`native`&&this.nativeWindowDragTargetRegistered&&!n?{pointerScreenX:o.x,pointerScreenY:o.y}:null}",
    "moveDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e||this.dragState==null)return;this.cancelMomentum();let r=this.dragState;if(r.recordMovementIntent(),this.nativeWindowDragActive)return;let i=this.nativeWindowDragStart;if(this.nativeWindowDragStart=null,i!=null){this.nativeWindowDragActive=!0;let e=this.getLayout(n).mascot,t=sl(n,i,a.screen.getAllDisplays().map(t=>{let n=Cp(t,this.layoutMode),r=this.getLayoutForDisplay(t,{...this.anchor,x:this.isQuickChatPresentation?n.x-this.mascotSize.width+26:n.x,y:n.y}).anchor,i=this.getLayoutForDisplay(t,{...this.anchor,x:n.x+n.width-(this.isQuickChatPresentation?26:0),y:n.y+n.height}).anchor;return{displayBounds:t.bounds,windowOriginBounds:{x:r.x-e.left,y:r.y-e.top,width:Math.max(0,i.x-r.x),height:Math.max(0,i.y-r.y)}}}));if(this.nativeWindowDragActive=t,this.logger().info(`Native pet window drag handoff`,{safe:{driver:`appkit-events`,started:t}}),t){this.nativeWindowDragCompletionTimer=setInterval(()=>{cl(n)||this.endDrag(n.webContents.id,void 0,`button-released`)},hm);return}}let o=a.screen.getCursorScreenPoint(),s=r.getCursorPointForSource({native:null,renderer:{x:t?.pointerScreenX??o.x,y:t?.pointerScreenY??o.y}});s!=null&&this.moveDragToPointer(n,s)}endDrag(e,t,n=`released`){let r=this.window;if(r==null||r.isDestroyed()||r.webContents.id!==e||this.dragState==null)return;let i=this.dragState,o=this.nativeWindowDragActive,s=o?ll(r):null;if(o)this.handleNativeWindowDragMove(r,s??void 0),this.logger().info(`Native pet window drag finished`,{safe:{reason:n}});else if(i.hasMovementIntent){let e=a.screen.getCursorScreenPoint(),n=i.getCursorPointForSource({native:null,renderer:{x:t?.pointerScreenX??e.x,y:t?.pointerScreenY??e.y}});n!=null&&this.moveDragToPointer(r,n)}if(this.suppressNextRendererThrow=o||i.shouldSuppressRendererThrow(),this.dragState=null,this.clearNativeWindowDragCompletionTimer(),this.nativeWindowDragActive=!1,this.nativeWindowDragStart=null,o?(this.rememberMovedWindow(r,s??this.layout?.windowBounds),(!this.isQuickChatPresentation||!i.hasMovementIntent)&&this.persistWindowBounds(r)):(this.hasDeferredLayout=!1,(!this.isQuickChatPresentation||!i.hasMovementIntent)&&this.reclampWindowToVisibleDisplay({shouldPersist:!0})),this.isQuickChatPresentation&&i.hasMovementIntent){let n=o||t==null?a.screen.getCursorScreenPoint():{x:t.pointerScreenX,y:t.pointerScreenY},i=a.screen.getDisplayNearestPoint(n);this.clearMovedWindowPersist(),this.hasDeferredLayout=!1;let s=null;if(n.x<=i.bounds.x+8?s=`left`:n.x>=i.bounds.x+i.bounds.width-8&&(s=`right`),s!=null&&a.screen.getDisplayNearestPoint({x:s===`left`?i.bounds.x-16:i.bounds.x+i.bounds.width+16,y:n.y}).id===i.id){this.setQuickChatStashed(e,s);return}o?this.persistWindowBounds(r):this.reclampWindowToVisibleDisplay({shouldPersist:!0}),this.snapQuickChatToPosition(i,Vp(n,i.workArea),!0);return}let c=this.dockTarget,l=Dm(this.anchor,this.presentationOffset);c!=null&&sp({current:l,next:l,target:{x:c.anchor.centerX,y:c.anchor.centerY}}).shouldDock&&this.dockPresentation(c.anchor,c.onDock)}",
    "setElementSize(e,{elementSizeRevision:t,isTrayVisible:n,mascot:r,nativeCompositionEnabled:a,tray:o}){let i=this.window;i==null||i.isDestroyed()||i.webContents.id!==e||(this.cancelMomentum(),this.layoutMode=n==null?`native`:`legacy`,this.mascotSize=r,this.traySize=o,this.applyLatestElementSizes(i),this.stageWindowForNativePresentation(i),this.showWindowIfReady(i))}",
    "applyLatestElementSizes(e){this.anchor={...this.anchor,width:this.mascotSize.width,height:this.mascotSize.height},this.applyLayout(e)}",
    "async createWindow(e){let t=await this.windowManager.createWindow({title:a.app.getName(),width:zB.width,height:zB.height,appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:process.platform===`linux`?!0:!1,show:!1,initialRoute:rV});return this.window=t,this.compositionHost.setOverlayWindow(t),this.rendererReady=this.windowManager.isWebContentsReady(t.webContents.id),this.displayBounds=null,this.displayId=null,this.dragState=null,this.layout=null,this.mascotSize=oV,this.mousePassthroughEnabled=!1,this.traySize=null,t.on(`closed`,()=>{this.window===t&&(this.cancelMomentum(),this.window=null,this.dragState=null,this.layout=null,this.rendererReady=!1,this.pointerInteractive=!1,this.mousePassthroughEnabled=!1,this.compositionHost.setOverlayWindow(null),this.broadcastOpenState())}),t}",
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1,r=!0,i=null){if(e.isDestroyed())return;let o=this.getLayoutForDisplay(t);this.displayId=t.id,this.layout=o,this.setWindowBounds(e,o.windowBounds,n,r),this.compositionHost.updateMascotRect(o.mascot),this.sendLayoutToRenderer(e,i)}getLayoutForDisplay(e){return UB({anchor:this.anchor,displayBounds:this.layoutMode===`native`?e.workArea:e.bounds,mode:this.layoutMode,mascotSize:this.mascotSize,nativeMaterialAttached:this.compositionHost.isNativeMaterialAttached(),previousPlacement:this.placement,traySize:this.traySize??(this.layoutMode===`native`?k2:O2)})}getLayout(e){if(this.layout??this.applyLayout(e),this.layout==null)throw Error(`Expected avatar overlay layout`);return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;let t=this.isOpen();this.windowStagedForNativePresentation&&=(e.setOpacity(1),!1),e.moveTop(),e.showInactive(),!t&&this.isOpen()&&(this.finishPendingPresentation(),this.broadcastOpenState())}showWindowIfReady(e){!this.rendererReady||this.initialPresentationState!==`ready`||(this.showWindow(e),this.applyPointerInteractivityPolicy())}stageWindowForNativePresentation(e){e.isDestroyed()||this.applyPointerInteractivityPolicy()}broadcastOpenState(){this.windowManager.sendMessageToAllRegisteredWindows({type:`avatar-overlay-open-state-changed`,isOpen:this.isOpen()})}",
    "applyPointerInteractivityPolicy(){return null}cancelMomentum(){}clearMovedWindowPersist(){}clearDetachedDisplayRestore(){}clearNativeWindowDragCompletionTimer(){}finishPendingPresentation(){}handleNativeWindowDragMove(){}logger(){return{info(){}}}moveDragToPointer(){}persistWindowBounds(){}reclampWindowToVisibleDisplay(){}rememberMovedWindow(e,t){this.rememberedWindowBounds=t}sendLayoutToRenderer(){}setQuickChatStashed(){}setWindowBounds(){}snapQuickChatToPosition(){}getCurrentDisplay(){return{id:1,bounds:{x:0,y:0,width:1920,height:1080},workArea:{x:0,y:0,width:1920,height:1080}}}};",
    "function L9({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?_ne:vne,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`?{backgroundColor:k9,backgroundMaterial:`mica`}:{backgroundColor:k9,backgroundMaterial:null}}",
  ].join("");
}

function retiredCompactDragCompletionBundleFixture() {
  const source = currentAvatarOverlayBundleFixture();
  const start = source.indexOf("endDrag(e,t,n=`released`){");
  const end = source.indexOf("setElementSize(e,", start);
  assert.ok(start >= 0 && end > start);
  const retiredEnd =
    "endDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;let r=this.dragState,i=this.windowServerDragActive,a=null;this.dragState=null,this.windowServerDragActive=!1,this.windowServerDragWindowX=null,i?this.persistWindowBounds(n,a??this.getCurrentDisplay()):this.reclampWindowToVisibleDisplay({shouldPersist:!0});let o=this.dockTarget;o!=null&&this.dockPresentation(o.anchor,o.onDock)}";
  return source.slice(0, start) + retiredEnd + source.slice(end);
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
      if (moduleName === "node:fs") return fs;
      if (moduleName === "node:os") return os;
      if (moduleName === "node:path") return path;
      if (moduleName === "electron") {
        return {
          app: { getName: () => "Codex" },
          screen: {
            getCursorScreenPoint: () => ({ x: 0, y: 0 }),
            getDisplayNearestPoint: () => ({
              bounds: { x: 0, y: 0, width: 1920, height: 1080 },
              id: 1,
              workArea: { x: 0, y: 0, width: 1920, height: 1080 },
            }),
            getAllDisplays: () => [{
              bounds: { x: 0, y: 0, width: 1920, height: 1080 },
              id: 1,
              workArea: { x: 0, y: 0, width: 1920, height: 1080 },
            }],
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

test("patches the current expanded drag completion as a syntactically complete callback", () => {
  const patched = applyPatchTwice(currentAvatarOverlayBundleFixture());

  assert.match(
    patched,
    /codexPetOverlayEndKWinDrag\([^,]+,\(\)=>\{if\(this\.suppressNextRendererThrow=/,
  );
  assert.doesNotThrow(() => new Function("require", patched));
});

test("rejects the retired compact drag completion byte-identically", () => {
  const source = retiredCompactDragCompletionBundleFixture();
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));

  assert.equal(result, source);
  assert.match(warnings.join("\n"), /current avatar overlay drag completion shape/);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
});

test("expanded endDrag completes KWin, Niri, and fallback once while preserving control flow", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const run = (route, { quickChat = false, rendererId = 1 } = {}) => {
    const { controller } = controllerFromPatchedSource(patched);
    const calls = [];
    const window = { isDestroyed: () => false, webContents: { id: 1 } };
    controller.window = window;
    controller.dragState = {
      getCursorPointForSource: ({ renderer }) => renderer,
      hasMovementIntent: quickChat,
      shouldSuppressRendererThrow: () => false,
    };
    controller.nativeWindowDragActive = false;
    controller.clearNativeWindowDragCompletionTimer = () => calls.push("clear");
    controller.persistWindowBounds = () => calls.push("persist");
    controller.reclampWindowToVisibleDisplay = () => calls.push("reclamp");
    controller.dockTarget = { anchor: "anchor", onDock: "handler" };
    controller.dockPresentation = () => calls.push("dock");
    controller.isQuickChatPresentation = quickChat;
    controller.codexPetOverlayEndKWinDrag = (_target, complete) => {
      calls.push("kwin");
      if (route !== "kwin") return false;
      complete();
      return true;
    };
    controller.codexPetOverlayEndNiriDrag = (_target, _event, complete) => {
      calls.push("niri");
      if (route !== "niri") return false;
      complete();
      return true;
    };

    controller.endDrag(rendererId, {});
    return calls;
  };

  assert.deepEqual(run("kwin"), ["kwin", "clear", "reclamp", "dock"]);
  assert.deepEqual(run("niri"), ["kwin", "niri", "clear", "reclamp", "dock"]);
  assert.deepEqual(run("fallback"), ["kwin", "niri", "clear", "reclamp", "dock"]);
  assert.deepEqual(run("fallback", { quickChat: true }), [
    "kwin", "niri", "clear", "reclamp",
  ]);
  assert.deepEqual(run("fallback", { rendererId: 2 }), []);
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

test("unlocked mascot drags stay inside the overlay and do not invoke native window dragging", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);
  const nativeDragCalls = [];
  const rendererLayouts = [];
  controller.window = {
    getBounds: () => ({ x: 100, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 1 },
  };
  controller.layout = {
    anchor: { x: 110, y: 210, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: { left: 10, top: 54, width: 276, height: 131 },
    windowBounds: { x: 100, y: 200, width: 356, height: 320 },
  };
  controller.compositionHost = {
    performWindowDrag: () => nativeDragCalls.push("window"),
    updateMascotRect: () => {},
  };
  controller.sendLayoutToRenderer = (_window, layout) => rendererLayouts.push(layout);

  controller.startDrag(1, { pointerWindowX: 20, pointerWindowY: 20 });
  controller.moveDrag(1, { pointerScreenX: 350, pointerScreenY: 500 });

  assert.deepEqual(nativeDragCalls, []);
  assert.deepEqual(JSON.parse(JSON.stringify(controller.codexPetOverlayMascotLocalPosition)), { left: 240, top: 280 });
  assert.deepEqual(JSON.parse(JSON.stringify(controller.layout.mascot)), { left: 240, top: 280, width: 40, height: 40 });
  assert.deepEqual(JSON.parse(JSON.stringify(controller.layout.tray)), { left: 4, top: 145, width: 276, height: 131 });
  assert.equal(rendererLayouts.length, 1);
});

test("notification tray chooses a non-overlapping vertical side and stays within overlay bounds", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);
  const windowBounds = { x: 400, y: 300, width: 356, height: 320 };
  const baseLayout = {
    anchor: { x: 410, y: 310, width: 112, height: 121 },
    mascot: { left: 10, top: 10, width: 112, height: 121 },
    placement: "top-end",
    tray: { left: 0, top: 0, width: 276, height: 131 },
    windowBounds,
  };

  controller.codexPetOverlayMascotLocalPosition = { left: 0, top: 0 };
  const atTop = controller.codexPetOverlayTrayAboveLeft(baseLayout);
  assert.deepEqual(JSON.parse(JSON.stringify(atTop.mascot)), { left: 0, top: 0, width: 112, height: 121 });
  assert.equal(atTop.tray.top, 125);
  assert.ok(atTop.tray.top >= atTop.mascot.top + atTop.mascot.height + 4);
  assert.deepEqual(JSON.parse(JSON.stringify(atTop.windowBounds)), windowBounds);

  controller.codexPetOverlayMascotLocalPosition = { left: 100, top: 100 };
  const snappedFromMiddle = controller.codexPetOverlayTrayAboveLeft(baseLayout);
  assert.deepEqual(JSON.parse(JSON.stringify(snappedFromMiddle.mascot)), { left: 100, top: 135, width: 112, height: 121 });
  assert.deepEqual(JSON.parse(JSON.stringify(controller.codexPetOverlayMascotLocalPosition)), { left: 100, top: 135 });
  assert.equal(snappedFromMiddle.tray.top, 0);
  assert.ok(snappedFromMiddle.tray.top + snappedFromMiddle.tray.height + 4 <= snappedFromMiddle.mascot.top);
  assert.deepEqual(JSON.parse(JSON.stringify(snappedFromMiddle.windowBounds)), windowBounds);

  controller.codexPetOverlayMascotLocalPosition = { left: 244, top: 180 };
  const withUpperSpace = controller.codexPetOverlayTrayAboveLeft(baseLayout);
  assert.deepEqual(JSON.parse(JSON.stringify(withUpperSpace.mascot)), { left: 244, top: 180, width: 112, height: 121 });
  assert.equal(withUpperSpace.tray.top, 45);
  assert.ok(withUpperSpace.tray.top + withUpperSpace.tray.height + 4 <= withUpperSpace.mascot.top);
  assert.ok(withUpperSpace.tray.left >= 0);
  assert.ok(withUpperSpace.tray.left + withUpperSpace.tray.width <= windowBounds.width);
  assert.ok(withUpperSpace.tray.top >= 0);
  assert.ok(withUpperSpace.tray.top + withUpperSpace.tray.height <= windowBounds.height);
  assert.deepEqual(JSON.parse(JSON.stringify(withUpperSpace.windowBounds)), windowBounds);

  controller.codexPetOverlayMascotLocalPosition = { left: 0, top: 0 };
  const oversizedTray = controller.codexPetOverlayTrayAboveLeft({
    ...baseLayout,
    tray: { left: 0, top: 0, width: 700, height: 700 },
  });
  assert.equal(oversizedTray.tray.width, 356);
  assert.equal(oversizedTray.tray.height, 195);
  assert.ok(oversizedTray.tray.left >= 0);
  assert.ok(oversizedTray.tray.top >= 0);
  assert.ok(oversizedTray.tray.left + oversizedTray.tray.width <= windowBounds.width);
  assert.ok(oversizedTray.tray.top + oversizedTray.tray.height <= windowBounds.height);
  assert.ok(oversizedTray.tray.top >= oversizedTray.mascot.top + oversizedTray.mascot.height + 4);
});

test("another renderer cannot consume or mutate a local mascot drag", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);
  const nativeDragCalls = [];
  let boundsWrites = 0;
  controller.window = {
    getBounds: () => ({ x: 100, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 1 },
  };
  controller.layout = {
    anchor: { x: 110, y: 210, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: { left: 10, top: 54, width: 276, height: 131 },
    windowBounds: { x: 100, y: 200, width: 356, height: 320 },
  };
  controller.compositionHost = {
    getCursorPosition: () => null,
    performWindowDrag: () => nativeDragCalls.push("window"),
    updateMascotRect() {},
  };
  controller.setWindowBounds = () => {
    boundsWrites += 1;
  };
  const before = JSON.parse(JSON.stringify(controller.layout));

  controller.startDrag(2, { pointerWindowX: 20, pointerWindowY: 20 });
  controller.moveDrag(2, { pointerScreenX: 350, pointerScreenY: 500 });

  assert.equal(controller.codexPetOverlayMascotDragState, undefined);
  assert.equal(controller.codexPetOverlayMascotLocalPosition, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(controller.layout)), before);
  assert.deepEqual(nativeDragCalls, []);
  assert.equal(boundsWrites, 0);

  controller.endDrag(2, {});
  assert.equal(controller.codexPetOverlayMascotDragState, undefined);
});

test("overlay close and recreate clear only ephemeral mascot drag state", async () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched);
  let closed;
  const localPosition = { left: 120, top: 80 };
  controller.codexPetOverlayMascotDragState = { offsetX: 3, offsetY: 4 };
  controller.codexPetOverlayMascotLocalPosition = localPosition;
  controller.windowManager.createWindow = async () => ({
    isDestroyed: () => false,
    isVisible: () => false,
    on(event, handler) {
      if (event === "closed") {
        closed = handler;
      }
    },
    webContents: { id: 1 },
  });

  await controller.createWindow();
  assert.equal(controller.codexPetOverlayMascotDragState, null);
  assert.equal(controller.codexPetOverlayMascotLocalPosition, localPosition);

  controller.codexPetOverlayMascotDragState = { offsetX: 7, offsetY: 8 };
  closed();
  assert.equal(controller.codexPetOverlayMascotDragState, null);
  assert.equal(controller.codexPetOverlayMascotLocalPosition, localPosition);
});

test("KWin start, move, and end use one compositor transport and one completion path", () => {
  const qdbusCalls = [];
  const { controller } = controllerFromPatchedSource(
    applyPetOverlayPatch(currentAvatarOverlayBundleFixture()),
    {
      process: { env: { XDG_CURRENT_DESKTOP: "KDE" } },
      childProcess: {
        execFileSync(command, args) {
          qdbusCalls.push([command, args]);
        },
      },
    },
  );
  const window = {
    getBounds: () => ({ x: 100, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    isVisible: () => true,
    webContents: { id: 1 },
  };
  const completions = [];
  let upstreamMoves = 0;
  controller.window = window;
  controller.layout = {
    anchor: { x: 110, y: 210, width: 40, height: 40 },
    mascot: { left: 10, top: 10, width: 40, height: 40 },
    placement: "top-end",
    tray: { left: 10, top: 54, width: 276, height: 131 },
    windowBounds: { x: 100, y: 200, width: 356, height: 320 },
  };
  controller.moveDragToPointer = () => {
    upstreamMoves += 1;
  };
  controller.persistWindowBounds = () => completions.push("persist");
  controller.dockTarget = { anchor: { centerX: 1, centerY: 2 }, onDock: "dock-handler" };
  controller.dockPresentation = () => completions.push("dock");

  controller.startDrag(1, {
    pointerScreenX: 400,
    pointerScreenY: 300,
    pointerWindowX: 300,
    pointerWindowY: 20,
  });
  assert.equal(controller.nativeWindowDragActive, true);
  assert.equal(controller.nativeWindowDragStart, null);

  controller.moveDrag(1, { pointerScreenX: 700, pointerScreenY: 500 });
  assert.equal(upstreamMoves, 0);

  controller.endDrag(1, { pointerScreenX: 700, pointerScreenY: 500 });
  assert.equal(upstreamMoves, 0);
  assert.deepEqual(completions, ["persist", "dock"]);
  assert.equal(controller.dragState, null);
  assert.equal(controller.nativeWindowDragActive, false);
  assert.equal(controller.codexPetOverlayKWinDragState, null);
  assert.deepEqual(qdbusCalls.map(([, args]) => args[2]), [
    "org.kde.kwin.Scripting.loadScript",
    "org.kde.kwin.Scripting.start",
    "org.kde.kwin.Scripting.unloadScript",
  ]);
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
  assert.match(calls[6][1], /-webkit-app-region:drag!important/);
  assert.match(calls[6][1], /app-region:drag!important/);
  assert.match(calls[6][1], /user-select:none!important/);
  assert.match(
    calls[6][1],
    /\[data-avatar-overlay-hit-region="mascot"\],\[data-avatar-mascot="true"\],\.no-drag,\[data-avatar-overlay-hit-region="notification-tray"\],\[data-avatar-overlay-hit-region="notification-scroll-control"\]\{-webkit-app-region:no-drag!important;app-region:no-drag!important;\}/,
  );
  assert.match(calls[7][1], /document\.documentElement\.style\.background/);
  assert.deepEqual(calls.slice(8), [["opacity", 1], ["workspaces", true, true], "moveTop", "showInactive"]);
  assert.deepEqual(timers.map((timer) => timer.delay), [0]);
  assert.equal(calls.includes("focus"), false);
  assert.equal(calls.includes("show"), false);

  timers[0].callback();
  assert.deepEqual(calls.at(-1), ["focusable", true]);

  handlers["did-finish-load"]();
  const cssCalls = calls.filter(([kind]) => kind === "css");
  const jsCalls = calls.filter(([kind]) => kind === "js");
  assert.equal(cssCalls.length, 2);
  assert.equal(jsCalls.length, 2);
  assert.match(cssCalls[1][1], /background:transparent!important/);
  assert.match(cssCalls[1][1], /-webkit-app-region:drag!important/);
  assert.match(cssCalls[1][1], /app-region:drag!important/);
  assert.match(
    cssCalls[1][1],
    /\[data-avatar-overlay-hit-region="mascot"\],\[data-avatar-mascot="true"\],\.no-drag,\[data-avatar-overlay-hit-region="notification-tray"\],\[data-avatar-overlay-hit-region="notification-scroll-control"\]\{-webkit-app-region:no-drag!important;app-region:no-drag!important;\}/,
  );
  assert.match(jsCalls[1][1], /document\.documentElement\.style\.background/);
});

test("unlocked pet overlays are frameless only on Linux and opt into whole-window input", async () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  assert.match(patched, /frame:process\.platform===`linux`\?!1:!0/);
  assert.match(patched, /codexPetOverlayShouldUseWholeWindowInput\(\)\{return process\.platform===`linux`&&this\.codexPetOverlaySettings\(\)\.lockPosition!==!0\}/);
  assert.match(patched, /codexLinuxWholeWindowInput=this\.codexPetOverlayShouldUseWholeWindowInput\(\)/);

  const { controller } = controllerFromPatchedSource(patched);
  const created = [];
  const makeWindow = () => ({
    isDestroyed: () => false,
    isVisible: () => false,
    on() {},
    webContents: { id: 1 },
  });
  controller.windowManager.createWindow = async (options) => {
    created.push(options);
    return makeWindow();
  };
  await controller.createWindow();
  assert.equal(created[0].frame, false);
  controller.codexPetOverlaySyncWindow(controller.window);
  assert.equal(controller.codexLinuxWholeWindowInput, true);

  const { controller: nonLinuxController } = controllerFromPatchedSource(patched, {
    process: { platform: "darwin" },
  });
  const nonLinuxCreated = [];
  nonLinuxController.windowManager.createWindow = async (options) => {
    nonLinuxCreated.push(options);
    return makeWindow();
  };
  await nonLinuxController.createWindow();
  assert.equal(nonLinuxCreated[0].frame, true);
  assert.equal(nonLinuxController.codexLinuxWholeWindowInput, undefined);
});

test("unlocked drag CSS protects native mascot markup without an overlay hit region", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const insertedCss = [];
  const { controller } = controllerFromPatchedSource(patched);
  const nativeMascotMarkup = '<div data-avatar-mascot="true"><button class="no-drag"></button></div>';
  assert.doesNotMatch(nativeMascotMarkup, /data-avatar-overlay-hit-region/);

  controller.codexPetOverlayInstallTransparentRenderer({
    isDestroyed: () => false,
    webContents: {
      insertCSS: (css) => insertedCss.push(css),
      isDestroyed: () => false,
      on() {},
    },
  });

  assert.match(
    insertedCss[0],
    /\[data-avatar-mascot="true"\],\.no-drag,\[data-avatar-overlay-hit-region="notification-tray"\],\[data-avatar-overlay-hit-region="notification-scroll-control"\]\{-webkit-app-region:no-drag!important;app-region:no-drag!important;\}/,
  );
});

test("locked pet overlays omit drag CSS and whole-window input", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { lockPosition: true } }, settings: {} },
  });
  const calls = [];
  const { controller } = controllerFromPatchedSource(patched);
  const window = {
    isDestroyed: () => false,
    webContents: {
      insertCSS: (css) => calls.push(css),
      isDestroyed: () => false,
      on() {},
    },
  };
  controller.codexPetOverlayInstallTransparentRenderer(window);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /app-region:(drag|no-drag)/);
  assert.doesNotMatch(calls[0], /-webkit-app-region:(drag|no-drag)/);
  assert.equal(controller.codexLinuxWholeWindowInput, false);
});

test("passive mode makes the overlay non-focusable", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { manifest: { petOverlay: { mode: "passive" } }, settings: {} },
  });

  assert.match(
    patched,
    /appearance:`avatarOverlay`,frame:process\.platform===`linux`\?!1:!0,alwaysOnTop:process\.platform===`linux`,skipTaskbar:process\.platform===`linux`,focusable:!1/,
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
  controller.layoutMode = "legacy";
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
  controller.layoutMode = "legacy";
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

function createAsyncNiriDragScenario() {
  const calls = [];
  const pending = [];
  const timers = [];
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "niri" } },
    childProcess: {
      execFile(command, args, options, callback) {
        assert.equal(command, "niri");
        assert.equal(options.timeout, 1200);
        calls.push(args);
        pending.push({ args, callback });
      },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
  });
  const window = {
    getBounds: () => ({ x: 100, y: 100, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 1 },
  };
  controller.window = window;
  controller.codexPetOverlayDesiredDisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
  controller.codexPetOverlayDesiredWindowBounds = { x: 100, y: 100, width: 356, height: 320 };
  return { calls, controller, pending, timers, window };
}

function completePendingNiriCall(scenario, { error = null, stdout = "ok" } = {}) {
  const call = scenario.pending.shift();
  assert.ok(call, "expected a pending niri call");
  call.callback(error, stdout);
  return call.args;
}

function niriPetWindow(id, isFloating = true) {
  return JSON.stringify([{
    id,
    is_floating: isFloating,
    layout: { window_size: [356, 320] },
    pid: 4242,
    title: "Codex Pet Overlay",
  }]);
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

test("Niri drag keeps one move in flight and emits only the latest queued target", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, window } = scenario;

  controller.codexPetOverlayBeginNiriDrag(window);
  assert.equal(pending.length, 1);
  completePendingNiriCall(scenario, { stdout: niriPetWindow(9) });
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending[0].args.slice(-4)), JSON.stringify(["-x", "100", "-y", "100"]));

  controller.codexPetOverlayDesiredWindowBounds = { x: 600, y: 100, width: 356, height: 320 };
  controller.codexPetOverlayQueueNiriDrag(window);
  controller.codexPetOverlayDesiredWindowBounds = { x: 120, y: 100, width: 356, height: 320 };
  controller.codexPetOverlayQueueNiriDrag(window);

  assert.equal(pending.length, 1, "a second compositor move must not overlap the first");
  completePendingNiriCall(scenario);
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending[0].args.slice(-4)), JSON.stringify(["-x", "120", "-y", "100"]));
  assert.equal(scenario.calls.some((args) => args.includes("600")), false);
});

test("Niri drag waits for an already-running bootstrap compositor action", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, window } = scenario;

  controller.codexPetOverlayNiri(["action", "move-floating-window", "--id", "9", "-x", "40", "-y", "40"]);
  assert.equal(pending.length, 1);
  controller.codexPetOverlayBeginNiriDrag(window);
  assert.equal(pending.length, 1, "drag discovery must wait for the bootstrap action");

  completePendingNiriCall(scenario);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("windows"), true);
});

test("completed Niri processes do not schedule another hint batch without a pending request", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, timers } = scenario;

  controller.codexPetOverlayNiri(["--json", "windows"]);
  assert.equal(pending.length, 1);
  completePendingNiriCall(scenario, { stdout: "[]" });

  assert.equal(pending.length, 0);
  assert.deepEqual(timers, []);
});

test("Niri drag floats a tiled pet before its first move", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, window } = scenario;

  controller.codexPetOverlayBeginNiriDrag(window);
  completePendingNiriCall(scenario, { stdout: niriPetWindow(9, false) });

  assert.equal(pending.length, 1);
  assert.equal(
    JSON.stringify(pending[0].args),
    JSON.stringify(["msg", "action", "move-window-to-floating", "--id", "9"]),
  );
  assert.equal(scenario.calls.some((args) => args.includes("move-floating-window")), false);

  completePendingNiriCall(scenario);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("move-floating-window"), true);
});

test("Niri endDrag drains the final move before persisting and docking", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, window } = scenario;
  const completed = [];
  let upstreamMoves = 0;
  controller.layout = {
    anchor: { x: 100, y: 100, width: 40, height: 40 },
    mascot: { left: 0, top: 0, width: 40, height: 40 },
    placement: "top-end",
    tray: { left: 0, top: 44, width: 276, height: 131 },
    windowBounds: { x: 100, y: 100, width: 356, height: 320 },
  };
  controller.moveDragToPointer = () => {
    upstreamMoves += 1;
  };
  controller.persistWindowBounds = (target, display) => completed.push(["persist", target, display]);
  controller.dockTarget = { anchor: { centerX: 1, centerY: 2 }, onDock: "dock-handler" };
  controller.dockPresentation = (anchor, onDock) => completed.push(["dock", anchor, onDock]);

  controller.startDrag(1, {
    pointerScreenX: 100,
    pointerScreenY: 100,
    pointerWindowX: 100,
    pointerWindowY: 100,
  });
  assert.equal(controller.nativeWindowDragActive, true);
  assert.equal(controller.nativeWindowDragStart, null);
  controller.moveDrag(1, { pointerScreenX: 220, pointerScreenY: 200 });
  controller.endDrag(1, { pointerScreenX: 250, pointerScreenY: 200 });

  assert.deepEqual(completed, []);
  assert.equal(upstreamMoves, 0);
  completePendingNiriCall(scenario, { stdout: niriPetWindow(9) });
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending[0].args.slice(-4)), JSON.stringify(["-x", "150", "-y", "100"]));
  assert.deepEqual(completed, []);
  completePendingNiriCall(scenario);

  assert.equal(completed.length, 2);
  assert.equal(completed[0][0], "persist");
  assert.equal(completed[0][1], window);
  assert.equal(completed[0][2], undefined);
  assert.deepEqual(completed[1], ["dock", { centerX: 1, centerY: 2 }, "dock-handler"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(controller.rememberedWindowBounds)),
    { x: 150, y: 100, width: 356, height: 320 },
  );
  assert.equal(upstreamMoves, 0);
  assert.equal(controller.codexPetOverlayNiriDragState, null);
});

test("stale Niri callbacks clear drag state and reschedule hints for a replacement window", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, timers, window: oldWindow } = scenario;
  controller.codexPetOverlayBeginNiriDrag(oldWindow);
  assert.equal(pending.length, 1);

  const newWindow = {
    getBounds: () => ({ x: 300, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 2 },
  };
  controller.window = newWindow;
  completePendingNiriCall(scenario, { stdout: niriPetWindow(41) });

  assert.equal(controller.codexPetOverlayNiriDragState, null);
  assert.deepEqual(timers.map((timer) => timer.delay), [0, 80, 300, 1000]);
});

test("Niri hint scheduling clears an idle drag state left by a replaced window", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, timers, window: oldWindow } = scenario;
  controller.codexPetOverlayBeginNiriDrag(oldWindow);
  completePendingNiriCall(scenario, { stdout: niriPetWindow(9) });
  completePendingNiriCall(scenario);
  assert.equal(pending.length, 0);
  assert.notEqual(controller.codexPetOverlayNiriDragState, null);

  const newWindow = {
    getBounds: () => ({ x: 300, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 2 },
  };
  controller.window = newWindow;
  controller.dragState = null;
  controller.codexPetOverlayScheduleNiriHints(newWindow);

  assert.equal(controller.codexPetOverlayNiriDragState, null);
  assert.deepEqual(timers.map((timer) => timer.delay), [0, 80, 300, 1000]);
});

test("stale Niri discovery callbacks cannot continue a replacement window drag", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, window: oldWindow } = scenario;
  controller.codexPetOverlayBeginNiriDrag(oldWindow);

  const newWindow = {
    getBounds: () => ({ x: 300, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 2 },
  };
  controller.window = newWindow;
  controller.codexPetOverlayDesiredWindowBounds = { x: 300, y: 200, width: 356, height: 320 };
  controller.codexPetOverlayBeginNiriDrag(newWindow);
  assert.equal(pending.length, 1, "replacement discovery must wait for the previous call");

  completePendingNiriCall(scenario, { stdout: niriPetWindow(41) });
  assert.equal(pending.length, 1, "the replacement discovery starts only after the stale call completes");
  completePendingNiriCall(scenario, { stdout: niriPetWindow(42) });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("42"), true);
  assert.equal(scenario.calls.some((args) => args.includes("41") && args.includes("action")), false);
});

test("Niri drag discovery recovery is bounded and ENOENT aborts immediately", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, timers, window } = scenario;
  controller.codexPetOverlayBeginNiriDrag(window);

  completePendingNiriCall(scenario, { error: new Error("discovery failed"), stdout: "" });
  assert.deepEqual(timers.map((timer) => timer.delay), [80]);
  timers.shift().callback();
  completePendingNiriCall(scenario, { error: new Error("discovery failed"), stdout: "" });
  assert.deepEqual(timers.map((timer) => timer.delay), [300]);
  timers.shift().callback();
  completePendingNiriCall(scenario, { stdout: "[]" });

  assert.equal(scenario.calls.filter((args) => args.includes("windows")).length, 3);
  assert.equal(controller.codexPetOverlayNiriDragState, null);
  assert.equal(pending.length, 0);

  const missingScenario = createAsyncNiriDragScenario();
  missingScenario.controller.codexPetOverlayBeginNiriDrag(missingScenario.window);
  const missingError = new Error("missing niri");
  missingError.code = "ENOENT";
  completePendingNiriCall(missingScenario, { error: missingError, stdout: "" });
  assert.equal(missingScenario.controller.codexPetOverlayNiriDragState, null);
  assert.deepEqual(missingScenario.timers, []);
});

test("Niri drag action failure invalidates the cached id and rediscovers once serialized", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, timers, window } = scenario;
  controller.codexPetOverlayBeginNiriDrag(window);
  completePendingNiriCall(scenario, { stdout: niriPetWindow(9) });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("move-floating-window"), true);

  completePendingNiriCall(scenario, { error: new Error("move failed"), stdout: "" });
  assert.equal(pending.length, 0);
  assert.deepEqual(timers.map((timer) => timer.delay), [80]);
  timers.shift().callback();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("windows"), true);

  completePendingNiriCall(scenario, { stdout: niriPetWindow(10) });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("10"), true);
  assert.equal(scenario.calls.filter((args) => args.includes("move-floating-window")).length, 2);
});

test("stale Niri action completion cannot continue a replacement drag", () => {
  const scenario = createAsyncNiriDragScenario();
  const { controller, pending, window: oldWindow } = scenario;
  controller.codexPetOverlayBeginNiriDrag(oldWindow);
  completePendingNiriCall(scenario, { stdout: niriPetWindow(41) });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("41"), true);

  const newWindow = {
    getBounds: () => ({ x: 300, y: 200, width: 356, height: 320 }),
    isDestroyed: () => false,
    webContents: { id: 2 },
  };
  controller.window = newWindow;
  controller.codexPetOverlayDesiredWindowBounds = { x: 300, y: 200, width: 356, height: 320 };
  controller.codexPetOverlayBeginNiriDrag(newWindow);
  assert.equal(pending.length, 1, "replacement drag must not overlap the previous compositor action");

  completePendingNiriCall(scenario);
  assert.equal(pending.length, 1, "replacement discovery starts after the old action completes");
  completePendingNiriCall(scenario, { stdout: niriPetWindow(42) });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].args.includes("42"), true);
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
      kwin: true,
      lockPosition: true,
      margin: 512,
      mode: "interactive",
      niri: true,
      skipTaskbar: true,
    },
  );
});

test("KWin Plasma bridge remains available with its runtime override and drag lifecycle", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());

  assert.equal(mergedPetOverlaySettings({}).kwin, true);
  assert.match(patched, /CODEX_PET_OVERLAY_KWIN/);
  assert.match(patched, /codexPetOverlayKWinQdbus\(/);
  assert.match(patched, /codexPetOverlayKWinDragScript\(/);
  assert.match(patched, /codexPetOverlayBeginKWinDrag\(/);
  assert.match(patched, /codexPetOverlayEndKWinDrag\(/);
});

test("KWin hints target only the matching Plasma pet and apply its Wayland bounds", () => {
  const calls = [];
  let script = null;
  const { controller } = controllerFromPatchedSource(
    applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
      feature: { manifest: { petOverlay: { kwin: true, lockPosition: true } }, settings: {} },
    }),
    {
      process: { env: { XDG_CURRENT_DESKTOP: "KDE" } },
      childProcess: {
        execFile(command, args, options, callback) {
          calls.push([command, args]);
          assert.equal(command, "qdbus6");
          assert.equal(options.timeout, 1500);
          if (args.includes("org.kde.kwin.Scripting.loadScript")) script = fs.readFileSync(args[3], "utf8");
          callback(null, "ok");
        },
      },
    },
  );
  const window = { isDestroyed: () => false };
  controller.window = window;
  controller.codexPetOverlayDesiredWindowBounds = { x: 610, y: 330, width: 356, height: 320 };

  controller.codexPetOverlayApplyKWinHints(window);

  assert.deepEqual(calls.map(([, args]) => args[2]), [
    "org.kde.kwin.Scripting.loadScript",
    "org.kde.kwin.Scripting.start",
    "org.kde.kwin.Scripting.unloadScript",
  ]);
  const pet = { caption: "Codex Pet Overlay", frameGeometry: { x: 0, y: 0, width: 356, height: 320 }, pid: 4242 };
  const foreign = { caption: "ChatGPT", frameGeometry: {}, pid: 4242 };
  vm.runInNewContext(script, { workspace: { raiseWindow() {}, windowList: () => [foreign, pet] } });
  assert.equal(pet.keepAbove, true);
  assert.equal(pet.noBorder, true);
  assert.deepEqual(JSON.parse(JSON.stringify(pet.frameGeometry)), { x: 610, y: 330, width: 356, height: 320 });
  assert.equal(foreign.keepAbove, undefined);
});

test("KWin drag uses qdbus, cleans up its temporary script, and honors its runtime override", () => {
  const calls = [];
  let script = null;
  const { controller } = controllerFromPatchedSource(applyPetOverlayPatch(currentAvatarOverlayBundleFixture()), {
    process: { env: { XDG_CURRENT_DESKTOP: "KDE" } },
    childProcess: {
      execFileSync(command, args, options) {
        calls.push([command, args, options]);
        if (args.includes("org.kde.kwin.Scripting.loadScript")) {
          script = fs.readFileSync(args[3], "utf8");
        }
      },
    },
  });
  const window = {
    getContentBounds: () => ({ x: 145, y: 210, width: 356, height: 320 }),
    isDestroyed: () => false,
  };
  let persisted = false;
  controller.window = window;

  controller.codexPetOverlayBeginKWinDrag(window);
  const scriptPath = controller.codexPetOverlayKWinDragState.scriptPath;
  assert.deepEqual(calls.slice(0, 2).map(([, args]) => args[2]), [
    "org.kde.kwin.Scripting.loadScript",
    "org.kde.kwin.Scripting.start",
  ]);
  assert.equal(calls[0][0], "qdbus6");
  assert.equal(calls[0][2].timeout, 750);
  assert.ok(script);

  const cursorSignal = { callback: null, connect(callback) { this.callback = callback; }, disconnect() {} };
  const removedSignal = { connect() {} };
  const pet = {
    caption: "Codex Pet Overlay",
    frameGeometry: { x: 100, y: 200, width: 356, height: 320 },
    pid: 4242,
  };
  const workspace = {
    cursorPos: { x: 130, y: 250 },
    cursorPosChanged: cursorSignal,
    raiseWindow() {},
    windowList: () => [pet],
    windowRemoved: removedSignal,
  };
  vm.runInNewContext(script, { workspace });
  assert.equal(typeof cursorSignal.callback, "function");
  workspace.cursorPos = { x: 300, y: 410 };
  cursorSignal.callback();
  assert.deepEqual(
    JSON.parse(JSON.stringify(pet.frameGeometry)),
    { x: 270, y: 360, width: 356, height: 320 },
  );

  controller.codexPetOverlayQueueKWinDrag(window);
  assert.equal(calls.length, 2, "pointer updates must not spawn compositor processes");
  assert.equal(fs.existsSync(scriptPath), true);
  assert.equal(controller.codexPetOverlayEndKWinDrag(window, () => { persisted = true; }), true);
  assert.equal(calls[2][1][2], "org.kde.kwin.Scripting.unloadScript");
  assert.equal(fs.existsSync(scriptPath), false);
  assert.equal(persisted, true);
  assert.equal(controller.codexPetOverlayKWinDragState, null);

  const overridden = controllerFromPatchedSource(applyPetOverlayPatch(currentAvatarOverlayBundleFixture()), {
    process: { env: { XDG_CURRENT_DESKTOP: "KDE", CODEX_PET_OVERLAY_KWIN: "0" } },
  }).controller;
  assert.equal(overridden.codexPetOverlayShouldUseKWin(), false);
});

test("KWin drag falls back without repeatedly probing missing qdbus commands", () => {
  const patched = applyPetOverlayPatch(currentAvatarOverlayBundleFixture());
  let calls = 0;
  const { controller } = controllerFromPatchedSource(patched, {
    process: { env: { XDG_CURRENT_DESKTOP: "KDE" } },
    childProcess: {
      execFileSync() {
        calls += 1;
        const error = new Error("qdbus missing");
        error.code = "ENOENT";
        throw error;
      },
    },
  });
  const window = { isDestroyed: () => false };
  controller.window = window;

  controller.codexPetOverlayBeginKWinDrag(window);

  assert.equal(calls, 2);
  assert.equal(controller.codexPetOverlayKWinDragState, undefined);
  controller.codexPetOverlayBeginKWinDrag(window);
  assert.equal(calls, 2);
});
