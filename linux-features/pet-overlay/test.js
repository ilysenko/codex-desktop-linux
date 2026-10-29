#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const nativeLayout = require("./fixtures/native-layout.js");
const nativeWindowGeometry = require("./fixtures/native-window-geometry.js");
const nativeInputPolicy = require("./fixtures/native-input-policy.js");
const nativePresentation = require("./fixtures/native-presentation.js");
const { signal, session: kwinSession, bridgeForSession } = require("./fixtures/kwin-session.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));
require("./kwin-bridge.test.cjs");
require("./renderer-gesture.test.cjs");

const {
  discoverLinuxFeatureManifests,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  DESCRIPTOR_ID,
  applyPetOverlayPatch,
  applyPetOverlayRendererPatch,
  mergedPetOverlaySettings,
} = require("./patch.js");

function copyFeatureTo(featuresRoot) {
  const featureDir = path.join(featuresRoot, "pet-overlay");
  fs.mkdirSync(featureDir, { recursive: true });
  for (const name of ["feature.json", "README.md", "patch.js", "launcher-hook.sh", "stage.sh", "native-kwin.cjs", "kwin-bridge.cjs", "kwin-script.cjs"]) {
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
    "let a=require(`electron`),f=require(`node:child_process`),hm=50;function sl(){return!1}function cl(){return!0}function ll(e){return e.getBounds?.()??e.getContentBounds?.()??null}function Cp(e){return e.workArea??e.bounds}function Dm(e,t){return{x:Number(e?.x??0)+Number(t?.x??0),y:Number(e?.y??0)+Number(t?.y??0)}}function sp(){return{shouldDock:!0}}function Vp(e){return e}var D=a,u={v:`avatar-overlay-position`},Fe={default:(e,t)=>JSON.stringify(e)===JSON.stringify(t)},jle=200;function yu(){return null}function Pp(e){return{x:e.x+e.width/2,y:e.y+e.height/2}}function Np(e){return JSON.stringify(e)}function Kp(){return`top-end`}function Gp(e){return e}function Wp(e){return e.workArea??e.bounds}function nm(e,t){return{x:Math.max(t.x,Math.min(t.x+t.width,e.x)),y:Math.max(t.y,Math.min(t.y+t.height,e.y))}}var tle=Dm,Sp=sp;function Op(id){return a.screen.getAllDisplays().find(display=>display.id===id)}",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},k2={width:0,height:0},O2={width:276,height:131};",
    "var h2=class{constructor(e,t,n,r){this.cursorSource=e;this.pointerAnchorX=t;this.pointerAnchorY=n;this.displayBounds=r;this.hasMovementIntent=!1;this.hasMoved=!1}getCursorPointForSource({native:e,renderer:t}){return this.cursorSource===`native`?e:t}recordMove(e){this.hasMovementIntent=!0,this.hasMoved=!0,this.displayBounds=e}recordMovementIntent(){this.hasMovementIntent=!0}shouldSuppressRendererThrow(){return!1}};",
    "var fV=class{window=null;rendererReady=!1;layout=null;mascotSize=oV;traySize=null;pointerInteractive=!1;mousePassthroughEnabled=!1;windowStagedForNativePresentation=!1;layoutMode=`native`;nativeWindowDragStart=null;nativeWindowDragActive=!1;nativeWindowDragCompletionTimer=null;nativeWindowDragTargetRegistered=!1;hasDeferredLayout=!1;isQuickChatPresentation=!1;presentationOffset={x:0,y:0};anchor={x:0,y:0,width:112,height:121};compositionHost={setOverlayWindow(){},isNativeMaterialAttached(){return!1},updateMascotRect(){}};nativePositionController={clear(){}};",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "isOpen(){let e=this.window;return e!=null&&!e.isDestroyed()&&e.isVisible()&&!this.windowStagedForNativePresentation}",
    "focusQuickChat(e){let t=this.window;this.windowManager.sendMessageToWebContents(t.webContents,{type:`avatar-overlay-action`,action:e==null?{type:`focus-quick-chat`}:{type:`focus-quick-chat`,requestId:e,wasHidden:!0}})}",
    'setKeyboardInteraction(e,t,n=!1){let r=this.window;if(null==r||r.isDestroyed()||r.webContents.id!==e||t&&(!this.shouldPresentWindow()||null!=this.pendingQuickChatFocus))return;this.applyPointerInteractivityPolicy();let i=this.nonactivatingPanelBridge?.fromPointer(r.getNativeWindowHandle()).window()??null;t?(this.handleQuickChatKeyboardInteraction(!0),r.setFocusable(!0),this.refreshNativeActiveAppearance(r),null!=i?(r.showInactive(),i.makeKeyAndOrderFront$(null)):(this.windowManager.setPendingAuxiliaryActivationTarget(r),r.show(),"darwin"===process.platform&&D.app.focus({steal:!0}),r.focus(),r.webContents.focus()),this.applyPointerInteractivityPolicy(),this.logger().debug("Pet keyboard focus requested",{safe:{nonactivating:null!=i,isKeyWindow:i?.isKeyWindow()}}),this.windowManager.sendMessageToWebContents(r.webContents,{type:this.isNotchEnabled?"notch-overlay-keyboard-interaction-ready":"avatar-overlay-keyboard-interaction-ready"})):"on-demand"===this.visibilityMode&&!this.hiddenOnDemand&&null==this.nativeAppearanceBridge&&r.isVisible()?this.handleQuickChatKeyboardInteraction(!1):(i?.isKeyWindow()&&i.resignKeyWindow(),r.setFocusable(!1),this.refreshNativeActiveAppearance(r),this.handleQuickChatKeyboardInteraction(!1,n&&null==i))}',
    "unregisterNativeWindowDragTarget(e){try{this.nativeWindowDragActive&&this.window!=null&&(this.suppressNextRendererThrow=!0)}finally{this.clearNativeWindowDragCompletionTimer(),this.dragState=null,this.hasDeferredLayout=!1,this.nativeWindowDragTargetRegistered=!1,this.nativeWindowDragStart=null,this.nativeWindowDragActive=!1}}",
    "startDrag(e,t,n=!1){let r=this.window;if(r==null||r.isDestroyed()||r.webContents.id!==e)return;this.nativeWindowDragActive&&this.endDrag(e,void 0,!1,`button-released`),this.cancelMomentum(),this.clearMovedWindowPersist(),this.clearNativeWindowDragCompletionTimer(),this.dockRestoreAnchor=null,this.nativeWindowDragActive=!1,this.suppressNextRendererThrow=!1,this.clearDetachedDisplayRestore();let i=this.getLayout(r),o=t.pointerScreenX!=null&&t.pointerScreenY!=null?{x:t.pointerScreenX,y:t.pointerScreenY}:a.screen.getCursorScreenPoint(),s=t.pointerWindowX-i.mascot.left,c=t.pointerWindowY-i.mascot.top;this.dragState=new h2(`renderer`,s,c,a.screen.getDisplayNearestPoint(o).bounds),this.nativeWindowDragStart=this.layoutMode===`native`&&this.nativeWindowDragTargetRegistered&&!n?{pointerScreenX:o.x,pointerScreenY:o.y}:null}",
    "moveDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e||this.dragState==null)return;this.cancelMomentum();let r=this.dragState;if(r.recordMovementIntent(),this.nativeWindowDragActive)return;let i=this.nativeWindowDragStart;if(this.nativeWindowDragStart=null,i!=null){this.nativeWindowDragActive=!0;let e=this.getLayout(n).mascot,t=sl(n,i,a.screen.getAllDisplays().map(t=>{let n=Cp(t,this.layoutMode),r=this.getLayoutForDisplay(t,{...this.anchor,x:this.isQuickChatPresentation?n.x-this.mascotSize.width+26:n.x,y:n.y}).anchor,i=this.getLayoutForDisplay(t,{...this.anchor,x:n.x+n.width-(this.isQuickChatPresentation?26:0),y:n.y+n.height}).anchor;return{displayBounds:t.bounds,windowOriginBounds:{x:r.x-e.left,y:r.y-e.top,width:Math.max(0,i.x-r.x),height:Math.max(0,i.y-r.y)}}}));if(this.nativeWindowDragActive=t,this.logger().info(`Native pet window drag handoff`,{safe:{driver:`appkit-events`,started:t}}),t){this.nativeWindowDragCompletionTimer=setInterval(()=>{cl(n)||this.endDrag(n.webContents.id,void 0,!1,`button-released`)},hm);return}}let o=a.screen.getCursorScreenPoint(),s=r.getCursorPointForSource({native:null,renderer:{x:t?.pointerScreenX??o.x,y:t?.pointerScreenY??o.y}});s!=null&&this.moveDragToPointer(n,s)}endDrag(e,t,n=!1,r=`released`){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e||this.dragState==null)return;let a=this.dragState,o=this.nativeWindowDragActive,s=o?yu(i):null,c=s?.bounds,l=o?s?.altKey===!0:n;if(o)this.handleNativeWindowDragMove(i,c),this.logger().info(`Native pet window drag finished`,{safe:{reason:r}});else if(a.hasMovementIntent){let e=D.screen.getCursorScreenPoint(),n=a.getCursorPointForSource({native:null,renderer:{x:t?.pointerScreenX??e.x,y:t?.pointerScreenY??e.y}});n!=null&&this.moveDragToPointer(i,n)}if(this.suppressNextRendererThrow=o||a.shouldSuppressRendererThrow(),this.dragState=null,this.clearNativeWindowDragCompletionTimer(),this.nativeWindowDragActive=!1,this.nativeWindowDragStart=null,a.hasMovementIntent&&(this.isFreelyPositioned=!l,this.snapPosition=null),l&&a.hasMovementIntent){let e=D.screen.getCursorScreenPoint();o?e={x:this.anchor.x+a.pointerAnchorX,y:this.anchor.y+a.pointerAnchorY}:t!=null&&(e={x:t.pointerScreenX,y:t.pointerScreenY});let n=D.screen.getDisplayNearestPoint(e),r=nm(e,n.workArea);this.clearMovedWindowPersist(),this.hasDeferredLayout=!1,this.suppressNextRendererThrow=!0,this.isQuickChatPresentation?this.snapQuickChatToPosition(n,r,!0):(this.snapPosition=r,this.animatePresentationTo(this.getPetSnapAnchor(n,r),{x:0,y:0},()=>this.persistWindowBounds(i,n),null,!0));return}o?(this.rememberMovedWindow(i,c??this.layout?.windowBounds),this.persistWindowBounds(i)):(this.hasDeferredLayout=!1,this.reclampWindowToVisibleDisplay({shouldPersist:!0}));let u=this.dockTarget,d=tle(this.anchor,this.presentationOffset);u!=null&&Sp({current:d,next:d,target:{x:u.anchor.centerX,y:u.anchor.centerY}}).shouldDock&&this.dockPresentation(u.anchor,u.onDock)}",
    "setElementSize(e,{elementSizeRevision:t,isTrayVisible:n,mascot:r,nativeCompositionEnabled:a,tray:o}){let i=this.window;i==null||i.isDestroyed()||i.webContents.id!==e||(this.cancelMomentum(),this.layoutMode=n==null?`native`:`legacy`,this.mascotSize=r,this.traySize=o,this.applyLatestElementSizes(i),this.stageWindowForNativePresentation(i),this.showWindowIfReady(i))}",
    "applyLatestElementSizes(e){this.anchor={...this.anchor,width:this.mascotSize.width,height:this.mascotSize.height},this.applyLayout(e)}",
    "async createWindow(e){let t=await this.windowManager.createWindow({title:a.app.getName(),width:zB.width,height:zB.height,appearance:\"avatarOverlay\",supportsWindowTiling:!1,focusable:!1,show:!1,initialRoute:rV});return this.window=t,this.compositionHost.setOverlayWindow(t),this.rendererReady=this.windowManager.isWebContentsReady(t.webContents.id),this.displayBounds=null,this.displayId=null,this.dragState=null,this.layout=null,this.mascotSize=oV,this.mousePassthroughEnabled=!1,this.traySize=null,t.on(`closed`,()=>{this.window===t&&(this.cancelMomentum(),this.window=null,this.dragState=null,this.layout=null,this.rendererReady=!1,this.pointerInteractive=!1,this.mousePassthroughEnabled=!1,this.compositionHost.setOverlayWindow(null),this.broadcastOpenState())}),t}",
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1){if(e.isDestroyed())return;if(this.nativeWindowDragActive||this.movedWindowPersistTimer!=null){this.hasDeferredLayout=!0,this.handleNativeWindowDragMove(e);return}let r=this.getLayoutForDisplay(t);this.quickChatResizeDrawAnchor!=null&&(this.quickChatDrawOffset={x:this.quickChatResizeDrawAnchor.x-r.anchor.x,y:this.quickChatResizeDrawAnchor.y-r.anchor.y}),this.displayId=t.id,this.resolutionKey=Np(t.bounds),this.displayBounds=t.bounds,this.anchor={...r.anchor,y:this.realtimeCaptionAboveMascotPx>0?this.anchor.y:r.anchor.y},this.layout=r,this.placement=r.placement,this.setWindowBounds(e,r.windowBounds,n),this.publishRemoteHostedPIPContentHost(),this.sendLayoutToRenderer(e),this.computerUseCursorLocation!=null&&this.dragState==null&&this.sendComputerUseCursorLocationToRenderer(e)}getLayoutForDisplay(e,t=this.anchor){let l=a.screen.getAllDisplays(),n=function({anchor:e,constrainNativeDrawWindowToDisplay:t=!1,...r}){return UB({anchor:e,constrainNativeDrawWindowToDisplay:t,...r})}({anchor:t,constrainNativeDrawWindowToDisplay:\"win32\"===process.platform,nativeDrawWindowBounds:process.platform===`darwin`&&l.length>1?e.bounds:void 0,displayBounds:this.layoutMode===`native`?e.workArea:e.bounds,mode:this.layoutMode,mascotSize:this.mascotSize,nativeMaterialAttached:this.compositionHost.isNativeMaterialAttached(),previousPlacement:this.placement,traySize:this.traySize??(this.layoutMode===`native`?k2:O2)});return n}getLayout(e){if(this.layout??this.applyLayout(e),this.layout==null)throw Error(`Expected avatar overlay layout`);return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;let t=this.isOpen();this.windowStagedForNativePresentation&&=(e.setOpacity(1),!1),e.moveTop(),e.showInactive(),t||\"on-demand\"!==this.visibilityMode||null!=this.nativeAppearanceBridge||(this.handleQuickChatKeyboardInteraction(!0),e.setFocusable(!0),this.windowManager.setPendingAuxiliaryActivationTarget(e),e.focus()),!t&&this.isOpen()&&(this.finishPendingPresentation(),this.broadcastOpenState())}showWindowIfReady(e){!this.rendererReady||this.initialPresentationState!==`ready`||(this.showWindow(e),this.applyPointerInteractivityPolicy())}stageWindowForNativePresentation(e){e.isDestroyed()||this.applyPointerInteractivityPolicy()}broadcastOpenState(){this.windowManager.sendMessageToAllRegisteredWindows({type:`avatar-overlay-open-state-changed`,isOpen:this.isOpen()})}",
    "publishRemoteHostedPIPContentHost(){}isOverlayWindowPointerDragActive(){return!1}applyPointerInteractivityPolicy(){return null}cancelMomentum(){}clearMovedWindowPersist(){this.movedWindowPersistTimer!=null&&(clearTimeout(this.movedWindowPersistTimer),this.movedWindowPersistTimer=null)}clearDetachedDisplayRestore(){}clearNativeWindowDragCompletionTimer(){}finishPendingPresentation(){}handleNativeWindowDragMove(e,t){let n=this.layout;if(e.isDestroyed()||n==null)return;let r=t??e.getContentBounds();this.anchor={...this.anchor,x:r.x+n.mascot.left,y:r.y+n.mascot.top};let i=D.screen.getDisplayNearestPoint(Pp(this.anchor));this.dragState?.recordMove(i.bounds),this.displayBounds=i.bounds,this.displayId=i.id,this.resolutionKey=Np(i.bounds),this.placement=Kp(this.anchor,i.workArea);let a=this.getLayoutForDisplay(i);this.layout={...a,anchor:this.anchor,mascot:n.mascot,quickChat:a.quickChat==null?void 0:{...a.quickChat,workArea:Gp(r,i.workArea)},tray:a.tray==null?null:{...a.tray,left:a.windowBounds.x+a.tray.left-r.x,top:a.windowBounds.y+a.tray.top-r.y},viewport:{width:r.width,height:r.height},visibleBounds:Gp(r,Wp(i,this.layoutMode)),windowBounds:r},this.placement=a.placement,this.publishRemoteHostedPIPContentHost(),this.sendLayoutToRenderer(e)}logger(){return{info(){}}}moveDragToPointer(){}persistWindowBounds(e,t=this.getCurrentDisplay()){if(this.isNotchEnabled||e.isDestroyed())return;let n=t.bounds,r={x:this.anchor.x+this.presentationOffset.x,y:this.anchor.y+this.presentationOffset.y,displayBounds:n,displayId:t.id,placement:this.placement,isFreelyPositioned:this.isFreelyPositioned,snapPosition:this.snapPosition},i=this.globalState.get(u.v),a=Np(n);this.displayId=t.id,this.resolutionKey=a;let o={...r,byDisplayId:{...i?.byDisplayId,[String(t.id)]:r},byResolution:{...i?.byResolution,[a]:r}};(0,Fe.default)(i,o)||this.isNotchManager||this.globalState.set(u.v,o)}reclampWindowToVisibleDisplay({shouldPersist:e}){let t=this.window;if(t==null||t.isDestroyed())return;let n=this.getCurrentDisplay();this.applyLayout(t,n),e&&this.persistWindowBounds(t,n)}rememberMovedWindow(e,t){if(e.isDestroyed()||this.layout==null)return;let n=t??e.getContentBounds();this.anchor={...this.anchor,x:n.x+this.layout.mascot.left,y:n.y+this.layout.mascot.top};let r=D.screen.getDisplayNearestPoint(Pp(this.anchor));this.displayBounds=r.bounds,this.displayId=r.id,this.resolutionKey=Np(r.bounds),this.isOverlayWindowPointerDragActive()&&this.clearDetachedDisplayRestore(),this.clearMovedWindowPersist(),this.movedWindowPersistTimer=setTimeout(()=>{(this.movedWindowPersistTimer=null,this.isOverlayWindowPointerDragActive())?this.rememberMovedWindow(e):(this.hasDeferredLayout&&(this.hasDeferredLayout=!1,this.applyLatestElementSizes(e)),this.applyPointerInteractivityPolicy(),this.reclampWindowToVisibleDisplay({shouldPersist:!0}))},jle)}sendLayoutToRenderer(){}setQuickChatStashed(){}setWindowBounds(e,t,n){if(!(e.isDestroyed()||Fe.default(e.getContentBounds(),t))){this.isSettingWindowBounds=!0;try{e.setContentBounds(t,n)}finally{this.isSettingWindowBounds=!1}}}snapQuickChatToPosition(){}getCurrentDisplay(){if(this.windowPresentation!=null)return this.windowPresentation.getDisplay();if(this.displayId!=null){let e=Op(this.displayId);if(e!=null)return e}return D.screen.getDisplayNearestPoint(Pp(this.anchor))}};",
    "function L9({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?_ne:vne,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`?{backgroundColor:k9,backgroundMaterial:`mica`}:{backgroundColor:k9,backgroundMaterial:null}}",
  ].join("").replace(
    "if(r.recordMovementIntent(),this.nativeWindowDragActive)return;",
    "if(r.recordMovementIntent(),this.quickChatStashedEdge!=null&&(this.quickChatStashedEdge=null,this.quickChatPosition=null,this.isFreelyPositioned=!0),this.nativeWindowDragActive)return;",
  ).replace("publishRemoteHostedPIPContentHost(){}isOverlayWindowPointerDragActive(){return!1}",
    nativeWindowGeometry + "isRemoteHostedPIPEnabled(){return!1}")
    .replace("snapQuickChatToPosition(){}", "")
    .replace("setQuickChatStashed(){}", nativeInputPolicy.slice(0, nativeInputPolicy.indexOf("}applyPointerInteractivityPolicy(") + 1) + "setQuickChatStashed(){}")
    .replace("sendLayoutToRenderer(){}", "sendLayoutToRenderer(){let e=tm(this.layout),t=e;}") +
    "function tm(e){return{...e}}var qde=class{completeQuickChatFocus(e,t){return this.manager.completeQuickChatFocus(this.origin.id,e,t)}};" +
    "function fL(n){return n.pointerScreenX==null?null:{pointerScreenX:n.pointerScreenX,pointerScreenY:n.pointerScreenY}}" +
    "function dragMessage(e,t,n){switch(n.type){case\"avatar-overlay-drag-start\":{let r=fL(n),i=r==null?{pointerWindowX:n.pointerWindowX,pointerWindowY:n.pointerWindowY}:{...r,pointerWindowX:n.pointerWindowX,pointerWindowY:n.pointerWindowY};e.startDrag(t.id,i,n.usesOrbPhysics);return}}}";
}

function retiredCompactDragCompletionBundleFixture() {
  const source = currentAvatarOverlayBundleFixture();
  const start = source.indexOf("endDrag(e,t,n=!1,r=`released`){");
  const end = source.indexOf("setElementSize(e,", start);
  assert.ok(start >= 0 && end > start);
  const retiredEnd =
    "endDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;let r=this.dragState,i=this.windowServerDragActive,a=null;this.dragState=null,this.windowServerDragActive=!1,this.windowServerDragWindowX=null,i?this.persistWindowBounds(n,a??this.getCurrentDisplay()):this.reclampWindowToVisibleDisplay({shouldPersist:!0});let o=this.dockTarget;o!=null&&this.dockPresentation(o.anchor,o.onDock)}";
  return source.slice(0, start) + retiredEnd + source.slice(end);
}

function nativePresentationBundleFixture() {
  const source = currentAvatarOverlayBundleFixture();
  const start = source.indexOf("showWindow(e){");
  const end = source.indexOf("showWindowIfReady(e){", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(0, start) + nativePresentation + source.slice(end);
}

test("native gesture service fails closed when RPC, dispatch or layout anchors drift", () => {
  const original = currentAvatarOverlayBundleFixture();
  for (const anchor of ["this.manager.completeQuickChatFocus", 'case"avatar-overlay-drag-start"', "=tm(this.layout),"])
    assert.equal(captureWarnings(() => applyPetOverlayPatch(original.replace(anchor, "drifted"))).result,
      original.replace(anchor, "drifted"));
  const duplicate = original + "var other=class{completeQuickChatFocus(e,t){return this.manager.completeQuickChatFocus(this.origin.id,e,t)}}";
  assert.equal(captureWarnings(() => applyPetOverlayPatch(duplicate)).result, duplicate);
});

test("gesture identity reaches the controller and RPC completion retains its origin renderer", async () => {
  const { context } = controllerFromPatchedSource(applyPetOverlayPatch(currentAvatarOverlayBundleFixture()));
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  for (const screen of [undefined, 100]) {
    let received;
    context.dragMessage({ startDrag: (...args) => { received = args; } }, { id: 7 }, {
      type: "avatar-overlay-drag-start", codexPetOverlayGestureId: id, pointerScreenX: screen, pointerWindowX: 74, pointerWindowY: 74,
    });
    assert.equal(received[0], 7);
    assert.equal(received[1].codexPetOverlayGestureId, id);
    assert.equal(received[1].pointerWindowX, 74);
  }
  const service = new context.qde();
  service.origin = { id: 7 };
  service.manager = { codexPetOverlayCompleteRendererDrag: (...args) => args };
  assert.deepEqual(service.codexPetOverlayCompleteDrag(id, false), [7, id, false, null]);
  const sample = { pointerScreenX: 130, pointerScreenY: 100 };
  assert.deepEqual(service.codexPetOverlayCompleteDrag(id, false, sample), [7, id, false, sample]);
});

function legacyAvatarOverlayBundleFixture() {
  return [
    "let n=require(`electron`);",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},sV={width:276,height:131};",
    "var fV=class{window=null;anchor={x:0,y:0,width:112,height:121};dragState=null;layout=null;mascotSize=oV;placement=`top-end`;traySize=null;",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "async createWindow(e){let t=await this.windowManager.createWindow({appearance:\"avatarOverlay\",focusable:!1,show:!1,initialRoute:rV});return this.window=t,t}",
    "applyLayout(e,t=n.screen.getDisplayNearestPoint(this.anchor).bounds){if(e.isDestroyed())return;let r=UB({anchor:this.anchor,displayBounds:t,mascotSize:this.mascotSize,previousPlacement:this.placement,traySize:this.traySize??sV});this.anchor=r.anchor,this.layout=r,this.placement=r.placement,this.setWindowBounds(e,r.windowBounds),this.sendLayoutToRenderer(e)}getLayout(e){return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;e.moveTop(),e.showInactive(),this.broadcastOpenState()}startDrag(e,t){this.dragState={}}broadcastOpenState(){}sendLayoutToRenderer(){}setWindowBounds(){}};",
  ].join("");
}

function controllerFromPatchedSource(patched, overrides = {}) {
  const context = {
    globalThis: {},
    Date: overrides.Date ?? Date,
    process: {
      env: {},
      pid: 4242,
      platform: "linux",
      resourcesPath: "/fixture/resources",
      ...overrides.process,
    },
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
    setInterval: overrides.setInterval ?? setInterval,
    clearInterval: overrides.clearInterval ?? clearInterval,
    Cle: 32,
    Me: 356,
    am: 12,
    je: {},
    Ip: (point, rect) => point.x >= rect.x && point.y >= rect.y &&
      point.x <= rect.x + rect.width && point.y <= rect.y + rect.height,
    Pu: (...args) => { context.globalThis.contentHost = args; return true; },
    rm: (point, _display, _mascot, size) => ({ ...point, ...size }),
    require(moduleName) {
      if (moduleName.endsWith("/pet-overlay/kwin-bridge.cjs")) return { KWinBridge: overrides.KWinBridge ?? class {
        epoch = 1;
        request() { return Promise.resolve(null); }
        invalidate() { this.epoch += 1; return Promise.resolve(); }
      } };
      if (moduleName === "node:child_process") {
        return overrides.childProcess ?? { execFile() {} };
      }
      if (moduleName === "node:fs") return fs;
      if (moduleName === "node:os") return os;
      if (moduleName === "node:path") return path;
      if (moduleName === "electron") {
        return {
          app: {
            getName: () => "Codex",
            commandLine: { getSwitchValue: () => overrides.ozonePlatform ?? "" },
          },
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
            ...overrides.screen,
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
    { get() {}, set() {} },
  );
  controller.shouldPresentWindow ??= () => true;
  controller.setPetPointerProximity ??= () => {};
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
      [
        ["feature:pet-overlay:pet-overlay-kwin-gesture", "webview-asset", "optional"],
        [`feature:pet-overlay:${DESCRIPTOR_ID}`, "main-bundle", "optional"],
        ["feature:pet-overlay:pet-overlay-hidden-focus", "webview-asset", "optional"],
      ],
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

const quickChatFocusFixture = `function action(t){let e=t.requestId;return cr({requestId:e,layoutRevision:null})}
function prepare(o,u,f){if(u==null||o?.layoutRevision==null)return;let{requestId:e,layoutRevision:t}=o,n=window.requestAnimationFrame(()=>{n=window.requestAnimationFrame(()=>{u.completeQuickChatFocus(e,t).then(t=>{t&&f(e)}).catch(failed)})});return()=>{window.cancelAnimationFrame(n)}}`;

function quickChatFocusScenario(visibilityState) {
  let serial = 0;
  const timers = new Map(), frames = new Map(), calls = [], completed = [], errors = [];
  const context = {
    document: { visibilityState: "visible" },
    cr: value => value,
    window: {
      setTimeout: callback => { timers.set(++serial, callback); return serial; },
      clearTimeout: id => timers.delete(id),
      requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
      cancelAnimationFrame: id => frames.delete(id),
    },
    failed: error => errors.push(error),
  };
  const patched = applyPetOverlayRendererPatch(quickChatFocusFixture);
  assert.equal(applyPetOverlayRendererPatch(patched), patched);
  vm.runInNewContext(patched, context);
  const api = { completeQuickChatFocus: (...args) => { calls.push(args); return Promise.resolve(true); } };
  const prepare = value => {
    const preparation = context.action({ requestId: value.requestId, codexPetOverlayHiddenFocus: visibilityState === "hidden" });
    preparation.layoutRevision = value.layoutRevision;
    return context.prepare(preparation, api, id => completed.push(id));
  };
  const run = queue => {
    const [id, callback] = queue.entries().next().value;
    queue.delete(id);
    callback();
  };
  return { timers, frames, calls, completed, errors, api, prepare, run };
}

for (const state of ["hidden", "visible"]) {
  test(`Mini focus completes after two stages in a ${state} renderer`, async () => {
    const scenario = quickChatFocusScenario(state);
    scenario.prepare({ requestId: 9, layoutRevision: 12 });
    const queue = state === "hidden" ? scenario.timers : scenario.frames;
    assert.equal((state === "hidden" ? scenario.frames : scenario.timers).size, 0);
    assert.equal(queue.size, 1);
    scenario.run(queue);
    assert.equal(scenario.calls.length, 0);
    scenario.run(queue);
    await Promise.resolve();
    assert.deepEqual(scenario.calls, [[9, 12]]);
    assert.deepEqual(scenario.completed, [9]);
  });

  for (const stage of [0, 1]) test(`Mini focus cancellation clears stage ${stage} in a ${state} renderer`, () => {
    const scenario = quickChatFocusScenario(state);
    const cancel = scenario.prepare({ requestId: 9, layoutRevision: 12 });
    const queue = state === "hidden" ? scenario.timers : scenario.frames;
    if (stage) scenario.run(queue);
    cancel();
    assert.equal(queue.size, 0);
    assert.equal(scenario.calls.length, 0);
  });
}

test("Mini focus waits for layout readiness and preserves native rejection and error handling", async () => {
  const scenario = quickChatFocusScenario("hidden");
  scenario.prepare({ requestId: 9, layoutRevision: null });
  assert.equal(scenario.timers.size, 0);
  scenario.api.completeQuickChatFocus = () => Promise.resolve(false);
  scenario.prepare({ requestId: 9, layoutRevision: 12 });
  scenario.run(scenario.timers);
  scenario.run(scenario.timers);
  await Promise.resolve();
  assert.deepEqual(scenario.completed, []);
  const error = new Error("Focus API unavailable");
  scenario.api.completeQuickChatFocus = () => Promise.reject(error);
  scenario.prepare({ requestId: 9, layoutRevision: 12 });
  scenario.run(scenario.timers);
  scenario.run(scenario.timers);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(scenario.errors, [error]);
});

test("Mini focus renderer patch rejects missing and duplicate scheduling anchors", () => {
  assert.throws(() => applyPetOverlayRendererPatch(quickChatFocusFixture.replace(".completeQuickChatFocus(", ".other(")));
  assert.throws(() => applyPetOverlayRendererPatch(quickChatFocusFixture + quickChatFocusFixture));
});

test("Mini focus renderer patch handles renamed minified identifiers and fails closed on action drift", () => {
  const renamed = quickChatFocusFixture.replace(/\b[etnouf]\b/g, id => `$${id}`);
  assert.doesNotThrow(() => new vm.Script(applyPetOverlayRendererPatch(renamed)));
  assert.throws(() => applyPetOverlayRendererPatch(quickChatFocusFixture.replace("layoutRevision:null", "other:null")));
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

for (const [platform, ozonePlatform, expected] of [
  ["linux", "wayland", true],
  ["linux", "x11", false],
  ["linux", "", false],
  ["win32", "", true],
  ["darwin", "", false],
]) test(`native drawing constraint: ${platform} ${ozonePlatform}`, () => {
  const { controller } = controllerFromPatchedSource(
    applyPatchTwice(currentAvatarOverlayBundleFixture()),
    {
      process: { platform, env: { XDG_SESSION_TYPE: "wayland" } },
      ozonePlatform,
      UB: options => options.constrainNativeDrawWindowToDisplay,
    },
  );
  assert.equal(controller.getLayoutForDisplay({ workArea: {}, bounds: {} }), expected);
  const actions = [];
  controller.windowManager.sendMessageToWebContents = (_contents, message) => actions.push(message.action);
  controller.window = { isVisible: () => false, webContents: {} };
  controller.focusQuickChat(9);
  assert.equal(actions.at(-1).codexPetOverlayHiddenFocus, platform === "linux" && ozonePlatform === "wayland");
  controller.window.isVisible = () => true;
  controller.focusQuickChat(10);
  assert.equal(actions.at(-1).codexPetOverlayHiddenFocus, false);
  controller.focusQuickChat();
  assert.deepEqual(Object.keys(actions.at(-1)), ["type"]);
});

for (const lockPosition of [false, true]) test(`native geometry keeps the pet inside a 1200px Wayland display: locked=${lockPosition}`, () => {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 62, y: 0, width: 1858, height: 1200 },
  };
  const anchor = { x: 500, y: 100, width: 112, height: 87 };
  const { controller } = controllerFromPatchedSource(
    applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
      feature: { settings: { petOverlay: { lockPosition } } },
    }),
    {
      ozonePlatform: "wayland",
      UB: options => {
        const bounded = options.constrainNativeDrawWindowToDisplay;
        return {
          anchor,
          mascot: { left: 500, top: bounded ? 100 : 1241, width: 112, height: 87 },
          tray: { left: 0, top: 0, width: 276, height: 131 },
          windowBounds: { x: 0, y: bounded ? 0 : -1141, width: 1138, height: bounded ? 1200 : 2369 },
        };
      },
    },
  );
  let bounds;
  controller.setWindowBounds = (_window, value) => { bounds = value; };
  controller.applyLayout({ isDestroyed: () => false }, display);
  assert.ok(bounds.height <= display.workArea.height);
  // A Wayland compositor may keep the window at y=0 despite the requested offset.
  assert.ok(controller.layout.mascot.top >= 0);
  assert.ok(controller.layout.mascot.top + controller.layout.mascot.height <= display.workArea.height);
});

for (const variant of ["missing", "duplicate", "foreign-owner"]) test(`native draw-constraint anchor fails closed: ${variant}`, () => {
  const anchor = 'constrainNativeDrawWindowToDisplay:"win32"===process.platform';
  let source = currentAvatarOverlayBundleFixture().replace(
    anchor,
    variant === "duplicate" ? `${anchor},${anchor}` : "otherConstraint:!1",
  );
  if (variant === "foreign-owner") source += `class Other{getLayoutForDisplay(){return{${anchor}}}}`;
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));
  assert.equal(result, source);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
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
    "kwin", "niri", "clear", "reclamp", "dock",
  ]);
  assert.deepEqual(run("fallback", { rendererId: 2 }), []);
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
          return args[2] === "org.kde.kwin.Scripting.loadScript" ? "0\n" : "";
        },
      },
    },
  );
  const window = {
    getBounds: () => ({ x: 100, y: 200, width: 356, height: 320 }),
    getContentBounds: () => ({ x: 100, y: 200, width: 356, height: 320 }),
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
  controller.clearMovedWindowPersist();
});

function kwinMascotDragScenario({ ozonePlatform = "wayland", lockPosition = false, failNative = false, screen, nativeLayout } = {}) {
  const calls = [], bridgeCalls = [], persisted = [], timers = [];
  const cursorSignal = signal();
  const pet = {
    caption: "Codex Pet Overlay", pid: 4242, resourceClass: "codex-desktop", wantsInput: true,
    internalId: "{60115083-b547-4bfe-b29f-3736ebcd996b}",
    frameGeometry: { x: -976, y: 0, width: 1138, height: 1200 },
    frameGeometryChanged: signal(),
  };
  const workspace = {
    cursorPos: { x: 100, y: 850 }, cursorPosChanged: cursorSignal,
    windowList: () => [pet], windowRemoved: signal(), windowAdded: signal(), windowActivated: signal(), raiseWindow() {},
  };
  const kwin = kwinSession(workspace);
  kwin.send("prepare", { width: pet.frameGeometry.width, height: pet.frameGeometry.height });
  let gate = async () => {};
  const KWinBridge = bridgeForSession(kwin, { calls: bridgeCalls, beforeCommand: (...args) => gate(...args) });
  const { controller } = controllerFromPatchedSource(applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { settings: { petOverlay: { lockPosition } } },
  }), {
    ozonePlatform,
    screen,
    KWinBridge,
    process: { env: { XDG_CURRENT_DESKTOP: "KDE" } },
    UB: nativeLayout ?? (({ anchor, mascotSize }) => ({
      anchor,
      mascot: { left: 1050, top: 800, ...mascotSize },
      windowBounds: { x: anchor.x - 1050, y: anchor.y - 800, width: 1138, height: 1200 },
      tray: null,
    })),
    setTimeout: callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    childProcess: {
      execFileSync(command, args) {
        calls.push([command, args]);
        if (failNative) throw Object.assign(new Error("qdbus unavailable"), { code: "ENOENT" });
        if (command === "busctl") {
          if (args[7] === "Match") return JSON.stringify({ type: "a(sssida{sv})", data: [
            [[`0_${pet.internalId}`, pet.caption, "", 100, 0.8, {}]],
          ] });
          const info = { caption: { type: "s", data: pet.caption }, uuid: { type: "s", data: pet.internalId } };
          for (const [key, value] of Object.entries(pet.frameGeometry)) info[key] = { type: "d", data: value };
          return JSON.stringify({ type: "a{sv}", data: [info] });
        }
        assert.fail(`Native geometry tests must use the session bridge, not ${command}`);
      },
    },
  });
  const window = Object.assign(new EventEmitter(), {
    getBounds: () => ({ ...pet.frameGeometry, x: 0, y: 0 }),
    getContentBounds: () => ({ ...pet.frameGeometry, x: 0, y: 0 }),
    setContentSize: (width, height) => { pet.frameGeometry = { ...pet.frameGeometry, width, height }; },
    isDestroyed: () => false, isVisible: () => true, webContents: { id: 1 },
  });
  controller.window = window;
  controller.mascotSize = { width: 112, height: 87 };
  controller.layout = {
    anchor: { x: 74, y: 800, width: 112, height: 87 },
    mascot: { left: 1050, top: 800, width: 112, height: 87 },
    tray: null, windowBounds: { ...pet.frameGeometry },
  };
  controller.globalState = {
    get: () => persisted.at(-1),
    set: (_key, value) => persisted.push(JSON.parse(JSON.stringify(value))),
  };
  let serial = 0, gestureId;
  const startAt = (event, caller = 1) => {
    gestureId = `aaaaaaaa-aaaa-aaaa-aaaa-${String(++serial).padStart(12, "0")}`;
    controller.startDrag(caller, { ...event, codexPetOverlayGestureId: gestureId });
    return gestureId;
  };
  const start = (caller = 1) => startAt({ pointerScreenX: workspace.cursorPos.x, pointerScreenY: workspace.cursorPos.y,
    pointerWindowX: 1076, pointerWindowY: 850 }, caller);
  const end = (altKey = false) => controller.codexPetOverlayCompleteRendererDrag(1, gestureId, altKey);
  return { controller, window, pet, workspace, cursorSignal, calls, bridgeCalls, persisted, timers, start, startAt, end,
    gate: fn => { gate = fn; } };
}

require("./native-kwin-tests.cjs")({ controllerFromPatchedSource, applyPetOverlayPatch, nativePresentationBundleFixture });

test("Wayland mascot dragging uses the KWin cursor and crosses the old overlay boundary without a jump", async () => {
  const scenario = kwinMascotDragScenario();
  const { controller, window, pet, workspace, cursorSignal, calls, persisted } = scenario;
  try {
    const before = { ...pet.frameGeometry };
    scenario.start(); await settle();
    assert.equal(controller.nativeWindowDragActive, true);
    assert.equal(controller.codexPetOverlayMascotDragState, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(pet.frameGeometry)), before, "pointer-down must preserve the grab offset");
    const discoveries = calls.length;
    assert.deepEqual(scenario.bridgeCalls, ["drag"]);
    workspace.cursorPos = { x: 1500, y: 500 };
    cursorSignal.emit();
    controller.moveDrag(1, { pointerScreenX: 9999, pointerScreenY: 9999 });
    assert.equal(pet.frameGeometry.x + controller.layout.mascot.left, 1474);
    assert.equal(pet.frameGeometry.y + controller.layout.mascot.top, 450);
    assert.equal(calls.length, discoveries, "pointer motion must not spawn compositor processes");
    const finalBounds = JSON.parse(JSON.stringify(pet.frameGeometry));
    await scenario.end();
    assert.deepEqual(JSON.parse(JSON.stringify(pet.frameGeometry)), finalBounds);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].x, 1474);
    assert.equal(persisted[0].y, 450);
    assert.equal(persisted[0].byDisplayId["1"].x, 1474);
    assert.equal(persisted[0].byDisplayId["1"].y, 450);
    assert.equal(controller.codexPetOverlayKWinDragState, null);
    assert.equal(controller.nativeWindowDragActive, false);
    assert.equal(controller.dragState, null);
    assert.equal(scenario.bridgeCalls.filter(op => op === "endDrag").length, 1);
  } finally {
    controller.codexPetOverlayEndKWinDrag(window);
  }
});

test("deferred native layout keeps the compositor position after release", async () => {
  const scenario = kwinMascotDragScenario();
  const { controller, window, workspace, cursorSignal, timers, persisted } = scenario;
  try {
    scenario.start(); await settle();
    workspace.cursorPos = { x: 1500, y: 500 };
    cursorSignal.emit();
    controller.applyLayout(window);
    assert.equal(controller.hasDeferredLayout, true);
    await scenario.end();
    timers.at(-1).callback();
    assert.equal(controller.hasDeferredLayout, false);
    assert.equal(controller.anchor.x, 1474);
    assert.equal(controller.anchor.y, 450);
    assert.equal(controller.layout.windowBounds.x + controller.layout.mascot.left, 1474);
    assert.equal(controller.layout.windowBounds.y + controller.layout.mascot.top, 450);
    assert.equal(persisted.at(-1).x, 1474);
    assert.equal(persisted.at(-1).y, 450);
  } finally {
    controller.unregisterNativeWindowDragTarget("hidden");
  }
});

test("native Plasma restores the saved anchor before trusting the new Electron window origin", () => {
  const { controller, window, pet } = kwinMascotDragScenario();
  controller.anchor = { x: 1474, y: 450, width: 112, height: 87 };
  controller.layout = null;
  controller.applyLayout(window);
  assert.equal(controller.codexPetOverlayDesiredWindowBounds.x, 570);
  assert.equal(controller.codexPetOverlayDesiredWindowBounds.y, -46);
  let placements = 0;
  controller.codexPetOverlayKWinRun = (bounds, move, done) => {
    if (move) { placements += 1; pet.frameGeometry = { ...bounds }; }
    done(null);
  };
  controller.codexPetOverlayApplyKWinHints(window);
  assert.equal(placements, 1);
  assert.equal(pet.frameGeometry.x, 570);
  assert.equal(pet.frameGeometry.y, -46);
  assert.equal(controller.codexPetOverlayKWinPosition.window, window);
  controller.codexPetOverlayApplyKWinHints(window);
  assert.equal(placements, 1, "later hints must preserve manual movement");
});

function clippedNativePetLayout({ anchor, mascotSize, displayBounds, traySize }) {
  // Native drawing clips an oversized canvas before converting the mascot to local coordinates.
  const x = Math.max(displayBounds.x, anchor.x - 800);
  const y = Math.max(displayBounds.y, anchor.y - 1200);
  const width = Math.min(anchor.x + 800, displayBounds.x + displayBounds.width) - x;
  const height = Math.min(anchor.y + 1200, displayBounds.y + displayBounds.height) - y;
  return {
    anchor: { ...anchor },
    placement: "top-end",
    mascot: { left: anchor.x - x, top: anchor.y - y, ...mascotSize },
    tray: { left: 0, top: 0, ...traySize },
    windowBounds: { x, y, width, height },
  };
}

test("native Plasma keeps the saved mascot anchor through repeated clipped layouts at the screen edges", () => {
  for (const anchor of [{ x: 1461, y: 310 }, { x: 1790, y: 600 }, { x: 74, y: 800 }]) {
    const { controller, window, pet } = kwinMascotDragScenario({ nativeLayout: clippedNativePetLayout });
    delete controller.codexPetOverlayMascotLocalPosition;
    controller.anchor = { ...anchor, width: 112, height: 87 };
    controller.traySize = { width: 330, height: 141 };
    controller.codexPetOverlayKWinRun = (bounds, move, done) => {
      if (move) pet.frameGeometry = { ...bounds };
      done(null);
    };
    for (let pass = 0; pass < 12; pass += 1) {
      if (pass === 6) {
        controller.unregisterNativeWindowDragTarget("hidden");
        controller.windowVisibilitySequence = 1;
        pet.frameGeometry = { x: 400, y: 0, width: 1138, height: 1200 };
      }
      controller.applyLayout(window);
      controller.codexPetOverlayApplyKWinHints(window);
      assert.deepEqual({ x: controller.anchor.x, y: controller.anchor.y }, anchor, `pass ${pass}`);
      assert.equal(pet.frameGeometry.x + controller.layout.mascot.left, anchor.x);
      assert.equal(pet.frameGeometry.y + controller.layout.mascot.top, anchor.y);
    }
  }
});

test("native Plasma drains a layout change made while its initial placement is in flight", () => {
  const { controller, window, pet } = kwinMascotDragScenario({ nativeLayout: clippedNativePetLayout });
  delete controller.codexPetOverlayMascotLocalPosition;
  controller.anchor = { x: 1461, y: 310, width: 112, height: 87 };
  controller.traySize = { width: 0, height: 0 };
  const pending = [];
  controller.codexPetOverlayKWinRun = (bounds, move, done) => pending.push(() => {
    if (move) pet.frameGeometry = { ...bounds };
    controller.rememberMovedWindow(window);
    done(null);
  });
  controller.applyLayout(window);
  controller.codexPetOverlayApplyKWinHints(window);
  controller.mascotSize = { width: 80, height: 87 };
  controller.traySize = { width: 330, height: 141 };
  controller.applyLatestElementSizes(window);
  pending.shift()();
  controller.codexPetOverlayApplyKWinHints(window);
  pending.shift()();
  assert.equal(pet.frameGeometry.x + controller.layout.mascot.left, 1461);
  assert.equal(pet.frameGeometry.y + controller.layout.mascot.top, 310);
});

test("an unapplied KWin placement cannot seed the geometry cache", () => {
  const { controller, window } = kwinMascotDragScenario();
  controller.anchor = { x: 1474, y: 450, width: 112, height: 87 };
  controller.applyLayout(window);
  controller.codexPetOverlayKWinRun = (_bounds, _move, done) => done(null);
  controller.codexPetOverlayApplyKWinHints(window);
  assert.equal(controller.codexPetOverlayKWinPosition, undefined);
});

test("a hint callback from a previous presentation cannot restore its geometry cache", () => {
  const { controller, window, pet } = kwinMascotDragScenario();
  controller.applyLayout(window);
  let complete;
  controller.codexPetOverlayKWinRun = (bounds, _move, done) => {
    pet.frameGeometry = { ...bounds };
    complete = done;
  };
  controller.codexPetOverlayApplyKWinHints(window);
  controller.unregisterNativeWindowDragTarget("hidden");
  controller.windowVisibilitySequence = 1;
  complete(null);
  assert.equal(controller.codexPetOverlayKWinPosition, null);
});

async function nativeKWinEventScenario() {
  const display = { id: 64, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 62, y: 0, width: 1858, height: 1200 } };
  const scenario = kwinMascotDragScenario({ screen: {
    getAllDisplays: () => [display], getDisplayNearestPoint: () => display,
  }, nativeLayout: options => nativeLayout({ ...options, previousPlacement: options.previousPlacement ?? "top-end",
    nativeDrawMascotSize: { width: 80, height: 87 }, nativeDrawDisplayHeightPx: 1200 }) });
  const { controller, window, pet, workspace } = scenario;
  const queue = [], browser = [], frames = [];
  let hold = false, published, geometry = { ...pet.frameGeometry };
  scenario.gate((op, data) => hold ? new Promise(resolve => queue.push({ op, data, resolve })) : undefined);
  const record = stage => {
    if (!published) return;
    frames.push({ stage, pet: { x: geometry.x + published.mascot.left, y: geometry.y + published.mascot.top },
      local: { ...published.mascot }, frame: { ...geometry },
      tray: published.tray && { x: published.tray.left - published.mascot.left, y: published.tray.top - published.mascot.top } });
  };
  Object.defineProperty(pet, "frameGeometry", { get: () => geometry, set: value => {
    geometry = { ...value }; record("compositor"); pet.frameGeometryChanged.emit();
    browser.push(() => controller.rememberMovedWindow(window));
  } });
  controller.sendLayoutToRenderer = () => { published = JSON.parse(JSON.stringify(controller.layout)); record("renderer"); };
  window.setContentSize = (width, height) => { pet.frameGeometry = { ...geometry, width, height }; };
  const next = async () => {
    await settle();
    const operation = queue.shift();
    assert.ok(operation, "a compositor operation must be queued");
    operation.resolve();
    await settle();
  };
  const drain = async () => { await settle(); let limit = 20; while (queue.length) { assert.ok(limit-- > 0); await next(); } };
  const events = () => { let limit = 20; while (browser.length) { assert.ok(limit-- > 0); browser.shift()(); } };
  const flushPosition = () => { const timer = controller.movedWindowPersistTimer; if (timer) timer.callback(); };
  delete controller.codexPetOverlayMascotLocalPosition;
  controller.anchor = { x: 800, y: 450, width: 112, height: 121 };
  controller.mascotSize = { width: 112, height: 121 };
  controller.traySize = { width: 330, height: 141 };
  controller.placement = "top-end";
  controller.layout = null;
  controller.applyLayout(window);
  controller.codexPetOverlayApplyKWinHints(window);
  await drain(); events(); flushPosition();
  frames.length = 0;
  hold = true;
  const grab = async () => {
    const point = { pointerWindowX: published.mascot.left + 24, pointerWindowY: published.mascot.top + 24 };
    workspace.cursorPos = { x: geometry.x + point.pointerWindowX, y: geometry.y + point.pointerWindowY };
    scenario.startAt({ ...point, pointerScreenX: workspace.cursorPos.x, pointerScreenY: workspace.cursorPos.y });
    await settle();
    if (queue[0]?.op === "drag") await next();
    return point;
  };
  const move = (x, y) => {
    workspace.cursorPos = { x, y };
    scenario.cursorSignal.emit();
    controller.moveDrag(1, { pointerScreenX: x, pointerScreenY: y });
  };
  const end = async () => { const result = scenario.end(); void result.catch(() => {}); await drain(); await result; };
  const close = async () => {
    hold = false; await drain(); controller.unregisterNativeWindowDragTarget("hidden");
    await settle(); events(); controller.clearMovedWindowPersist();
  };
  return { ...scenario, queue, browser, frames, next, drain, events, flushPosition, grab, move, end, close };
}

test("native KWin preserves every published pet position through drag, resize events and settle", async () => {
  const scenario = await nativeKWinEventScenario();
  const { controller, window, frames } = scenario;
  try {
    await scenario.grab();
    scenario.move(1100, 520);
    const count = frames.length;
    await scenario.end();
    scenario.events(); scenario.flushPosition();
    controller.codexPetOverlayApplyKWinHints(window);
    scenario.events(); await scenario.drain(); scenario.events(); scenario.flushPosition();
    for (const frame of frames.slice(count - 1)) {
      assert.equal(frame.pet.x, 1076, frame.stage);
      assert.equal(frame.pet.y, 496, frame.stage);
      assert.equal(frame.frame.width, 1858);
      assert.equal(frame.frame.height, 1200);
    }
    assert.equal(new Set(frames.slice(count - 1).map(frame => JSON.stringify(frame.tray))).size, 1,
      "settle must not alternate centered and above-left notification targets");
  } finally { await scenario.close(); }
});

test("native KWin constrains the gesture at the edge without a release correction", async () => {
  for (const [x, y, expectedX, expectedY] of [
    [1900, 700, 1808, 676], [2000, 1300, 1808, 1071],
    [0, -100, 62, 0], [1100, -100, 1076, 0],
  ]) {
    const scenario = await nativeKWinEventScenario();
    try {
      await scenario.grab(); scenario.move(x, y);
      const count = scenario.frames.length;
      await scenario.end();
      scenario.events(); scenario.flushPosition();
      scenario.controller.codexPetOverlayApplyKWinHints(scenario.window);
      scenario.events(); await scenario.drain(); scenario.events(); scenario.flushPosition();
      const frames = scenario.frames.slice(count - 1);
      assert.deepEqual([...new Set(frames.map(frame => frame.pet.x))], [expectedX]);
      assert.deepEqual([...new Set(frames.map(frame => frame.pet.y))], [expectedY]);
      assert.equal(new Set(frames.map(frame => JSON.stringify(frame.local))).size, 1);
      assert.equal(new Set(frames.map(frame => `${frame.frame.width}x${frame.frame.height}`)).size, 1);
      assert.equal(scenario.persisted.at(-1).x, expectedX);
      assert.equal(scenario.persisted.at(-1).y, expectedY);
    } finally { await scenario.close(); }
  }
});

test("new drag invalidates an old hint and waits for its acknowledgement", async () => {
  const scenario = await nativeKWinEventScenario();
  try {
    scenario.controller.codexPetOverlayDesiredWindowBounds = { ...scenario.pet.frameGeometry, x: 50 };
    scenario.controller.codexPetOverlayApplyKWinHints(scenario.window);
    await settle();
    assert.equal(scenario.queue[0].op, "hints");
    const point = await scenario.grab();
    assert.equal(scenario.controller.codexPetOverlayKWinDragState.pending, true);
    scenario.workspace.cursorPos = { x: 1100, y: 520 };
    await scenario.next();
    assert.equal(scenario.queue[0].op, "drag");
    await scenario.next();
    assert.equal(scenario.controller.codexPetOverlayKWinDragState.pending, false);
    assert.equal(scenario.pet.frameGeometry.x + point.pointerWindowX, 1100);
    scenario.move(1200, 550);
    assert.equal(scenario.frames.at(-1).pet.x, 1176);
    assert.equal(scenario.frames.some(frame => frame.frame.x === 50), false, "stale script must never mutate the window");
    await scenario.end(); scenario.flushPosition();
  } finally { await scenario.close(); }
});

test("release before a pending KWin handoff preserves position and cannot start a late drag", async () => {
  const scenario = await nativeKWinEventScenario();
  try {
    scenario.controller.codexPetOverlayApplyKWinHints(scenario.window);
    await scenario.grab();
    const anchor = { ...scenario.controller.anchor };
    await assert.rejects(scenario.end(), /before compositor handoff/);
    await scenario.drain();
    assert.equal(scenario.controller.codexPetOverlayKWinDragState, null);
    assert.equal(scenario.controller.nativeWindowDragActive, false);
    assert.deepEqual({ ...scenario.controller.anchor }, anchor);
    assert.equal(scenario.bridgeCalls.includes("drag"), false);
  } finally { await scenario.close(); }
});

test("programmatic geometry is guarded before a KWin hint has started", async () => {
  const scenario = await nativeKWinEventScenario();
  try {
    scenario.controller.anchor = { ...scenario.controller.anchor, x: 1000 };
    scenario.controller.applyLayout(scenario.window);
    assert.ok(scenario.controller.codexPetOverlayKWinPendingBounds);
    scenario.controller.rememberMovedWindow(scenario.window);
    assert.equal(scenario.controller.anchor.x, 1000);
    scenario.controller.codexPetOverlayApplyKWinHints(scenario.window);
    await scenario.drain(); scenario.events();
    assert.equal(scenario.controller.anchor.x, 1000);
    assert.equal(scenario.controller.codexPetOverlayKWinPendingBounds, null);
  } finally { await scenario.close(); }
});

test("KWin hints recheck physical geometry after the compositor moves an existing surface", async () => {
  const scenario = await nativeKWinEventScenario();
  try {
    const desired = { ...scenario.controller.codexPetOverlayDesiredWindowBounds };
    const anchor = { ...scenario.controller.anchor };
    scenario.pet.frameGeometry = { ...desired, x: desired.x + 27.35 };
    scenario.events();
    assert.equal(scenario.controller.codexPetOverlayKWinPosition.bounds.x, desired.x,
      "the cached position deliberately still matches the desired bounds");
    scenario.controller.codexPetOverlayApplyKWinHints(scenario.window);
    await scenario.drain(); scenario.events(); scenario.flushPosition();
    assert.deepEqual({ ...scenario.pet.frameGeometry }, desired);
    assert.equal(scenario.controller.anchor.x, anchor.x);
    assert.equal(scenario.controller.anchor.y, anchor.y);
  } finally { await scenario.close(); }
});

test("KWin script IDs reject failures and malformed replies", () => {
  const { controller } = kwinMascotDragScenario();
  for (const value of ["", "-1", "NaN", "ok", "0/other", "2147483648", undefined])
    assert.equal(controller.codexPetOverlayKWinScriptId(value), null);
  assert.equal(controller.codexPetOverlayKWinScriptId("0\n"), 0);
  assert.equal(controller.codexPetOverlayKWinScriptId("123"), 123);
});

test("native KWin fixed canvas preserves locked gravity in all corners", () => {
  for (const gravity of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    const { controller, window } = kwinMascotDragScenario({ lockPosition: true,
      nativeLayout: options => nativeLayout({ ...options, previousPlacement: "top-end" }) });
    controller.codexPetOverlaySettings = () => ({ lockPosition: true, gravity, margin: 24, kwin: true });
    controller.anchor = { x: 800, y: 400, width: 112, height: 87 };
    controller.traySize = { width: 330, height: 141 };
    controller.applyLayout(window);
    assert.equal(controller.anchor.x, gravity.endsWith("left") ? 24 : 1920 - 24 - 112);
    assert.equal(controller.anchor.y, gravity.startsWith("top") ? 24 : 1080 - 24 - 87);
  }
});

test("native KWin canvas uses logical dimensions of the smallest connected display", () => {
  const displays = [
    { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
      workArea: { x: 62, y: 0, width: 1858, height: 1200 } },
    { id: 2, scaleFactor: 1.5, bounds: { x: -1280, y: 0, width: 1280, height: 720 },
      workArea: { x: -1280, y: 0, width: 1280, height: 688 } },
  ];
  const { controller } = kwinMascotDragScenario({ screen: { getAllDisplays: () => displays } });
  for (const display of displays) {
    const bounds = controller.codexPetOverlayKWinDrawBounds(display, { x: display.workArea.x + 100, y: 100, width: 112, height: 121 });
    assert.equal(bounds.width, 1280);
    assert.equal(bounds.height, 688);
    assert.equal(bounds.x + Math.round((bounds.width - 112) / 2), display.workArea.x + 100);
  }
});

for (const origin of [{ x: -400, y: -200 }, { x: 400, y: 200 }])
  test(`KWin hover and cursor consumers share compositor geometry: ${JSON.stringify(origin)}`, () => {
    let cursor, tick;
    const messages = [], input = [];
    const { controller, context } = controllerFromPatchedSource(applyPatchTwice(currentAvatarOverlayBundleFixture()), {
      ozonePlatform: "wayland", process: { env: { XDG_CURRENT_DESKTOP: "KDE" } },
      screen: { getCursorScreenPoint: () => cursor },
      setInterval: callback => { tick = callback; return { unref() {} }; },
      childProcess: { execFileSync() { assert.fail("hover must use cached geometry"); } },
    });
    const bounds = { ...origin, width: 1920, height: 1200 };
    const window = { isDestroyed: () => false, isVisible: () => true,
      getContentBounds: () => ({ ...bounds, x: 0, y: 0 }),
      webContents: { id: 1, sendInputEvent: event => input.push(event) } };
    controller.window = window;
    controller.rendererReady = true;
    controller.codexPetOverlayKWinPosition = { window, bounds };
    controller.layout = { anchor: { x: origin.x + 900, y: origin.y + 600 },
      mascot: { left: 900, top: 600, width: 112, height: 87 } };
    controller.showsPetControls = true;
    controller.shouldPresentWindow = () => true;
    controller.petControlsAppearance = { proximityEnterDistance: 8, proximityExitDistance: 16 };
    controller.petControlsProximityRects = [{ left: 900, top: 695, width: 140, height: 32 }];
    controller.setPetPointerProximity = value => { controller.pointerNearPet = value; };
    controller.logger = () => ({ debug() {}, info() {} });
    controller.windowManager.sendMessageToWebContents = (_contents, message) => messages.push(message);
    const localCursor = (x, y) => { cursor = { x: origin.x + x, y: origin.y + y }; };
    let proximityRequests = 0;
    controller.codexPetOverlayKWinProximity = () => { proximityRequests += 1; return true; };
    controller.updateCssPetControlsProximityTracking();
    assert.equal(proximityRequests, 1);
    assert.equal(tick, undefined, "native hover must not poll Electron's global pointer");
    controller.codexPetOverlayKWinDragGeneration = 1;
    controller.codexPetOverlayKWinDragState = { window, generation: 1 };
    localCursor(-20, -20);
    assert.equal(controller.isOverlayWindowPointerDragActive(), true);
    controller.codexPetOverlayKWinDragState = null;
    localCursor(956, 710);
    assert.equal(controller.sendCursorPointToAvatarOverlay(window, cursor, false), true);
    assert.deepEqual(JSON.parse(JSON.stringify(input.at(-1))),
      { type: "mouseMove", x: 956, y: 710, movementX: 0, movementY: 0 });
    controller.computerUseCursorPoint = cursor;
    controller.sendComputerUseCursorLocationToRenderer(window);
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1).point)), { x: 956, y: 710 });
    controller.pointerInteractive = true;
    controller.dragState = {};
    localCursor(10, 10);
    assert.equal(controller.isOverlayWindowPointerDragActive(), true);
    localCursor(-20, -20);
    assert.equal(controller.isOverlayWindowPointerDragActive(), false);
    assert.equal(controller.sendCursorPointToAvatarOverlay(window, cursor, false), false);
    controller.isRemoteHostedPIPEnabled = () => true;
    controller.remoteHostedPIPContentHostMotionTarget = { x: origin.x + 900, y: origin.y + 600, width: 112, height: 87 };
    controller.publishRemoteHostedPIPContentHost();
    assert.deepEqual(JSON.parse(JSON.stringify(context.globalThis.contentHost[2].anchorRect)),
      { x: 900, y: 600, width: 112, height: 87 });
    controller.getQuickChatRestingWidth = () => 356;
    controller.quickChatDrawOffset = { x: 0, y: 0 };
    controller.animatePresentationTo = () => {};
    controller.snapQuickChatToPosition({ workArea: bounds },
      { x: origin.x + (origin.x < 0 ? 40 : 1500), y: origin.y + 100 }, true, true);
    assert.ok(controller.quickChatResizeDrawAnchor, "the snap target fits inside the physical canvas");
  });

test("a recovered KWin bridge keeps the grab point after a local fallback move", async () => {
  const scenario = kwinMascotDragScenario({
    nativeLayout: options => nativeLayout({ ...options, previousPlacement: "top-end" }),
  });
  const { controller, window, pet, workspace, cursorSignal } = scenario;
  controller.codexPetOverlayKWinGeometryUnavailable = true;
  controller.applyLayout(window);
  const before = controller.layout.mascot;
  scenario.startAt({ pointerWindowX: before.left + 10, pointerWindowY: before.top + 10 });
  controller.moveDrag(1, { pointerWindowX: 600, pointerWindowY: 300 });
  await scenario.end();
  controller.applyLatestElementSizes(window);
  controller.codexPetOverlayKWinGeometryUnavailable = false;
  controller.codexPetOverlayKWinRun = (bounds, move, done) => { if (move) pet.frameGeometry = { ...bounds }; done(null); };
  controller.codexPetOverlayApplyKWinHints(window);
  const local = { ...controller.layout.mascot };
  const bounds = { ...pet.frameGeometry };
  workspace.cursorPos = { x: bounds.x + local.left + 10, y: bounds.y + local.top + 10 };
  try {
    scenario.startAt({ pointerWindowX: local.left + 10, pointerWindowY: local.top + 10 });
    await settle();
    assert.ok(controller.codexPetOverlayKWinDragState);
    assert.deepEqual({ ...pet.frameGeometry }, bounds);
    workspace.cursorPos = { x: 1100, y: 500 }; cursorSignal.emit();
    await scenario.end();
    const anchor = { ...controller.anchor };
    controller.clearMovedWindowPersist();
    controller.applyLatestElementSizes(window);
    controller.codexPetOverlayApplyKWinHints(window);
    assert.equal(pet.frameGeometry.x + controller.layout.mascot.left, anchor.x);
    assert.equal(pet.frameGeometry.y + controller.layout.mascot.top, anchor.y);
  } finally { controller.unregisterNativeWindowDragTarget("hidden"); }
});

for (const name of ["updateCssPetControlsProximityTracking", "sendCursorPointToAvatarOverlay",
  "sendComputerUseCursorLocationToRenderer", "isOverlayWindowPointerDragActive",
  "publishRemoteHostedPIPContentHost", "snapQuickChatToPosition"])
  test(`coordinate consumer hooks fail closed when ${name} drifts`, () => {
    const source = currentAvatarOverlayBundleFixture().replace(new RegExp(`(?<![\\w$.])${name}\\(`), `${name}Renamed(`) +
      `class Unrelated{${name}(e){return e.getContentBounds()}}`;
    const { result } = captureWarnings(() => applyPetOverlayPatch(source));
    assert.equal(result, source);
  });

test("native input regions cover controls and editor while transparent space stays click-through", () => {
  const context = { process: { platform: "linux" } };
  vm.runInNewContext(`this.Policy=class{${nativeInputPolicy}}`, context);
  const policy = new context.Policy(), shapes = [];
  policy.supportsInputShape = true;
  policy.mousePassthroughMode = "disabled";
  policy.window = { isDestroyed: () => false, isVisible: () => true,
    setInputShape: shape => { shapes.push(shape); return true; },
    webContents: { id: 1 } };
  const mascot = { left: 900, top: 600, width: 112, height: 87 };
  const controls = { left: 880, top: 695, width: 160, height: 40 };
  const editor = { left: 700, top: 400, width: 500, height: 200 };
  policy.setPointerRegions(1, [mascot, controls], [controls]);
  const contains = (x, y) => shapes.at(-1).some(r => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
  assert.equal(contains(950, 650), true);
  assert.equal(contains(900, 710), true);
  assert.equal(contains(100, 100), false);
  policy.setPointerRegions(1, [mascot, controls, editor], [controls]);
  assert.equal(contains(750, 450), true);
  policy.setPointerRegions(2, [], []);
  assert.equal(shapes.length, 2, "another renderer cannot change the input shape");
});

for (const missing of ["busctl", "qdbus"])
  test(`native local fallback survives the next layout with missing ${missing}`, () => {
    const scenario = kwinMascotDragScenario({ nativeLayout: options => nativeLayout({ ...options, previousPlacement: "top-end" }) });
    const { controller, window } = scenario;
    delete controller.codexPetOverlayMascotLocalPosition;
    if (missing === "busctl") controller.codexPetOverlayKWinGeometryUnavailable = true;
    else controller.codexPetOverlayKWinBridge = { closed: true };
    controller.applyLayout(window);
    const before = { ...controller.layout.mascot };
    controller.startDrag(1, { pointerWindowX: before.left + 10, pointerWindowY: before.top + 10 });
    controller.moveDrag(1, { pointerWindowX: 600, pointerWindowY: 300 });
    controller.endDrag(1, {});
    const moved = { ...controller.layout.mascot };
    assert.notEqual(moved.left, before.left);
    for (let i = 0; i < 3; i += 1) {
      controller.applyLatestElementSizes(window);
      assert.deepEqual({ ...controller.layout.mascot }, moved);
    }
  });

test("native tray fits the visible canvas with a small second display and after hot-unplug", () => {
  const main = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  const small = { id: 2, scaleFactor: 1.5, bounds: { x: -800, y: 0, width: 800, height: 600 },
    workArea: { x: -800, y: 0, width: 800, height: 600 } };
  let displays = [main, small];
  const { controller, window } = kwinMascotDragScenario({ screen: {
    getAllDisplays: () => displays, getDisplayNearestPoint: () => main,
  }, nativeLayout: options => nativeLayout({ ...options, previousPlacement: "top-end" }) });
  delete controller.codexPetOverlayMascotLocalPosition;
  controller.mascotSize = { width: 80, height: 87 };
  controller.traySize = { width: 330, height: 300 };
  for (const placement of ["top-end", "bottom-end"]) {
    controller.placement = placement;
    for (const y of [100, 500, 1000]) {
      controller.anchor = { x: 800, y, ...controller.mascotSize };
      const layout = controller.getLayoutForDisplay(main);
      const { tray, visibleBounds: visible } = layout;
      assert.ok(tray.top >= visible.top, placement);
      assert.ok(tray.top + tray.height <= visible.top + visible.height, placement);
      assert.ok(tray.left >= visible.left, placement);
      assert.ok(tray.left + tray.width <= visible.left + visible.width, placement);
      assert.ok(tray.height > 0, placement);
      const mascot = layout.mascot;
      assert.ok(tray.top + tray.height + 12 <= mascot.top || tray.top >= mascot.top + mascot.height + 12,
        "upstream pet/tray spacing must survive canvas fitting");
    }
  }
  displays = [main];
  const larger = controller.getLayoutForDisplay(main);
  assert.equal(larger.windowBounds.width, main.workArea.width);
  assert.equal(larger.windowBounds.height, main.workArea.height);
  controller.unregisterNativeWindowDragTarget("hidden");
});

test("local fallback offsets let upstream place notifications on the available canvas side", () => {
  const scenario = kwinMascotDragScenario({ nativeLayout: options => nativeLayout({ ...options, previousPlacement: options.previousPlacement ?? "top-end" }) });
  const { controller, window } = scenario;
  controller.codexPetOverlayKWinUnavailable = true;
  controller.anchor = { x: 800, y: 900, width: 80, height: 87 };
  controller.mascotSize = { width: 80, height: 87 };
  controller.traySize = { width: 330, height: 300 };
  for (const top of [10, 900]) {
    controller.codexPetOverlayMascotLocalPosition = { left: 920, top };
    controller.applyLatestElementSizes(window);
    const { mascot, tray, visibleBounds: visible } = controller.layout;
    assert.ok(tray.height > 0);
    assert.ok(tray.top >= visible.top && tray.top + tray.height <= visible.top + visible.height);
    assert.ok(tray.top + tray.height + 12 <= mascot.top || tray.top >= mascot.top + mascot.height + 12,
      JSON.stringify({ mascot, tray, visible, placement: controller.layout.placement }));
  }
});

test("canvas tray fitting preserves the anchor through repeated layouts at the local bottom edge", () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  const { controller, window, pet } = kwinMascotDragScenario({ screen: {
    getAllDisplays: () => [display], getDisplayNearestPoint: () => display,
  }, nativeLayout: options => nativeLayout({ ...options, previousPlacement: options.previousPlacement ?? "top-end" }) });
  controller.anchor = { x: 800, y: 300, width: 80, height: 87 };
  controller.mascotSize = { width: 80, height: 87 };
  controller.traySize = { width: 330, height: 300 };
  controller.applyLayout(window);
  pet.frameGeometry = { ...controller.layout.windowBounds };
  controller.codexPetOverlayKWinPosition = { window, bounds: { ...pet.frameGeometry } };
  controller.codexPetOverlayKWinUnavailable = true;
  const mascot = controller.layout.mascot;
  controller.startDrag(1, { pointerWindowX: mascot.left + 10, pointerWindowY: mascot.top + 10 });
  controller.moveDrag(1, { pointerWindowX: 930, pointerWindowY: 1123 });
  controller.endDrag(1, {});
  const anchor = { ...controller.anchor };
  for (let i = 0; i < 6; i += 1) {
    controller.applyLatestElementSizes(window);
    assert.deepEqual({ ...controller.anchor }, anchor);
    assert.equal(controller.layout.windowBounds.y, pet.frameGeometry.y);
    assert.ok(controller.layout.tray.height > 0);
  }
});

test("native canvas fitting retains notification space with controls, captions and docked content", () => {
  const main = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  for (const [width, height] of [[1920, 1200], [800, 600], [600, 800], [400, 400]]) {
    const small = { id: 2, bounds: { x: -width, y: 0, width, height },
      workArea: { x: -width, y: 0, width, height } };
    let extra = {};
    const { controller, window } = kwinMascotDragScenario({ screen: {
      getAllDisplays: () => [main, small], getDisplayNearestPoint: () => main,
    }, nativeLayout: options => nativeLayout({ ...options, ...extra, previousPlacement: options.previousPlacement ?? "top-end" }) });
    controller.mascotSize = { width: 80, height: 87 };
    controller.traySize = { width: 330, height: 300 };
    for (extra of [{}, { showsPetControls: true },
      { showsPetControls: true, petControlRowHeight: 40, realtimeCaptionAboveMascotPx: 60 },
      { dockedPIPStackDisplayHeight: 200 }]) {
      for (const placement of ["top-end", "bottom-end"]) {
        for (const top of [0, 10, 100, Math.floor((height - 87) / 2), height - 95, height - 87]) {
          for (const x of [40, 800, 1800]) {
            for (const y of [0, 50, 300, 600, 1050]) {
              controller.codexPetOverlayKWinCanvas = null;
              controller.codexPetOverlayMascotLocalPosition = { left: (width - 80) / 2, top };
              controller.anchor = { x, y, ...controller.mascotSize };
              controller.placement = placement;
              let anchor;
              for (let pass = 0; pass < 6; pass += 1) {
                controller.applyLayout(window);
                const { mascot, tray, visibleBounds: visible } = controller.layout;
                const context = JSON.stringify({ width, height, extra, placement, top, x, y, pass, mascot, tray, visible });
                if (anchor) assert.deepEqual({ ...controller.anchor }, anchor, context);
                anchor = { ...controller.anchor };
                if (tray.height > 0) {
                  assert.ok(tray.top >= visible.top && tray.top + tray.height <= visible.top + visible.height, context);
                  assert.ok(tray.left >= visible.left && tray.left + tray.width <= visible.left + visible.width, context);
                  assert.ok(tray.top + tray.height + 12 <= mascot.top || tray.top >= mascot.top + mascot.height + 12, context);
                }
                if (Math.max(mascot.top - visible.top, visible.top + visible.height - mascot.top - mascot.height) > 250) {
                  assert.ok(tray.height > 0, context);
                }
              }
            }
          }
        }
      }
    }
    controller.unregisterNativeWindowDragTarget("hidden");
  }
});

test("native canvas shifts the tray frame horizontally before limiting its responsive width", () => {
  const main = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
  const small = { id: 2, bounds: { x: -400, y: 0, width: 400, height: 400 },
    workArea: { x: -400, y: 0, width: 400, height: 400 } };
  const { controller } = kwinMascotDragScenario({ screen: {
    getAllDisplays: () => [main, small], getDisplayNearestPoint: () => main,
  }, nativeLayout: options => nativeLayout({ ...options, previousPlacement: options.previousPlacement ?? "top-end" }) });
  controller.mascotSize = { width: 80, height: 87 };
  controller.traySize = { width: 330, height: 300 };
  for (const left of [0, 10, 160, 310, 320]) {
    for (const x of [40, 800, 1800]) {
      controller.codexPetOverlayMascotLocalPosition = { left, top: 156 };
      controller.anchor = { x, y: 600, ...controller.mascotSize };
      const { tray, visibleBounds: visible } = controller.getLayoutForDisplay(main);
      assert.ok(tray.height > 0);
      assert.equal(tray.width, Math.min(330, visible.width));
      assert.ok(tray.left >= visible.left && tray.left + tray.width <= visible.left + visible.width);
    }
  }
});

test("KWin completion preserves the renderer Alt modifier", async () => {
  const { controller, window, start, end, workspace, cursorSignal } = kwinMascotDragScenario();
  let snaps = 0;
  controller.getPetSnapAnchor = (_display, anchor) => anchor;
  controller.animatePresentationTo = (_anchor, _offset, complete) => { snaps += 1; complete(); };
  try {
    start(); await settle();
    workspace.cursorPos = { x: 1500, y: 500 };
    cursorSignal.emit();
    controller.moveDrag(1, {});
    await end(true);
    assert.equal(snaps, 1);
    assert.equal(controller.isFreelyPositioned, false);
  } finally {
    controller.unregisterNativeWindowDragTarget("hidden");
  }
});

test("KWin final geometry selects a negative-origin secondary display", async () => {
  const left = { id: 2, scaleFactor: 1.5, bounds: { x: -1920, y: 0, width: 1920, height: 1200 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1200 } };
  const right = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 62, y: 0, width: 1858, height: 1200 } };
  const { controller, window, start, end, workspace, cursorSignal, persisted } = kwinMascotDragScenario({ screen: {
    getAllDisplays: () => [right, left], getDisplayNearestPoint: point => point.x < 0 ? left : right,
  } });
  try {
    start(); await settle();
    workspace.cursorPos = { x: -1500, y: 500 };
    cursorSignal.emit();
    await end();
    assert.equal(persisted[0].displayId, 2);
    assert.equal(persisted[0].x, -1526);
    assert.equal(persisted[0].y, 450);
    assert.equal(persisted[0].byDisplayId["2"].x, -1526);
  } finally {
    controller.unregisterNativeWindowDragTarget("hidden");
  }
});

test("a missing final KWin reply keeps the last saved position and releases the drag", async () => {
  const { controller, window, start, end, persisted } = kwinMascotDragScenario();
  start(); await settle();
  const bridge = controller.codexPetOverlayKWinBridge, request = bridge.request.bind(bridge);
  bridge.request = async (...args) => { const value = await request(...args); return args[0] === "endDrag" ? null : value; };
  const anchor = { ...controller.anchor };
  await assert.rejects(end(), /not confirmed/);
  assert.equal(persisted.length, 0);
  assert.deepEqual({ ...controller.anchor }, anchor);
  assert.equal(controller.dragState, null);
  assert.equal(controller.nativeWindowDragActive, false);
  assert.equal(controller.codexPetOverlayKWinDragState, null);
  controller.unregisterNativeWindowDragTarget("hidden");
});

test("successful D-Bus calls with no matching window retain local mascot dragging", () => {
  const { controller, start, calls } = kwinMascotDragScenario();
  controller.codexPetOverlayKWinCall = () => ({ type: "a(sssida{sv})", data: [[]] });
  start();
  assert.ok(controller.codexPetOverlayMascotDragState);
  assert.equal(controller.nativeWindowDragActive, false);
  assert.equal(calls.length, 0);
});

test("KWin geometry rejects ambiguous matches, invalid numbers, foreign IDs and PIDs", () => {
  const { controller, window, pet } = kwinMascotDragScenario();
  const reply = { type: "a{sv}", data: [{
    caption: { type: "s", data: pet.caption }, uuid: { type: "s", data: pet.internalId },
    pid: { type: "u", data: 4242 },
    ...Object.fromEntries(Object.entries(pet.frameGeometry).map(([key, data]) => [key, { type: "d", data }])),
  }] };
  controller.codexPetOverlayKWinCall = () => reply;
  assert.ok(controller.codexPetOverlayKWinReadWindow(window, pet.internalId));
  for (const [key, value] of [["pid", 31337], ["uuid", "other"], ["caption", "Other"],
    ["x", "100"], ["y", null], ["width", -1], ["height", Infinity]]) {
    const copy = structuredClone(reply);
    copy.data[0][key].data = value;
    controller.codexPetOverlayKWinCall = () => copy;
    assert.equal(controller.codexPetOverlayKWinReadWindow(window, pet.internalId), null, key);
  }
  controller.codexPetOverlayKWinCall = () => ({ type: "a(sssuda{sv})", data: [[
    [`0_${pet.internalId}`, pet.caption], [`0_${pet.internalId}`, pet.caption],
  ]] });
  assert.equal(controller.codexPetOverlayKWinFindWindow(window), null);
});

test("missing busctl is probed once and leaves local mascot dragging available", () => {
  const { controller, start, calls } = kwinMascotDragScenario({ failNative: true });
  start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "busctl");
  assert.equal(controller.codexPetOverlayKWinGeometryUnavailable, true);
  controller.endDrag(1, {});
  start();
  assert.equal(calls.length, 1);
  assert.ok(controller.codexPetOverlayMascotDragState);
});

test("the move-settle callback refreshes a compositor move outside the mascot gesture", async () => {
  const { controller, window, start, end, pet, timers, persisted } = kwinMascotDragScenario();
  start(); await settle();
  await end();
  pet.frameGeometry = { ...pet.frameGeometry, x: 400, y: -300 };
  controller.rememberMovedWindow(window);
  timers.at(-1).callback();
  assert.equal(controller.anchor.x, 1450);
  assert.equal(controller.anchor.y, 500);
  assert.equal(persisted.at(-1).x, 1450);
  assert.equal(persisted.at(-1).y, 500);
});

for (const name of ["handleNativeWindowDragMove", "rememberMovedWindow"]) {
  test(`compositor geometry hooks fail closed when ${name} drifts`, () => {
    const source = currentAvatarOverlayBundleFixture().replace(`${name}(e,t){`, `other${name}(e,t){`) +
      `class Unrelated{${name}(e,t){}}`;
    const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));
    assert.equal(result, source);
    assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
  });
}

for (const options of [{ ozonePlatform: "x11" }, { failNative: true }]) {
  test(`mascot dragging retains the local fallback: ${JSON.stringify(options)}`, () => {
    const scenario = kwinMascotDragScenario(options);
    scenario.start();
    assert.ok(scenario.controller.codexPetOverlayMascotDragState);
    assert.equal(scenario.controller.nativeWindowDragActive, false);
    assert.equal(scenario.controller.dragState, undefined);
    scenario.controller.endDrag(1, {});
    assert.equal(scenario.controller.codexPetOverlayMascotDragState, null);
  });
}

for (const variant of ["locked", "foreign-renderer"]) {
  test(`Wayland mascot dragging preserves the ${variant} guard`, () => {
    const scenario = kwinMascotDragScenario({ lockPosition: variant === "locked" });
    scenario.start(variant === "foreign-renderer" ? 2 : 1);
    assert.equal(scenario.calls.length, 0);
    assert.equal(scenario.controller.codexPetOverlayMascotDragState, undefined);
    assert.equal(scenario.controller.codexPetOverlayKWinDragState, undefined);
  });
}

for (const reason of ["hidden", "closed"]) {
  test(`interrupting a KWin drag stops the session when ${reason}`, async () => {
    const { controller, window, workspace, pet, cursorSignal, bridgeCalls, start } = kwinMascotDragScenario();
    start(); await settle();
    let hintRequests = 0;
    controller.codexPetOverlayScheduleKWinHints = () => { hintRequests += 1; };
    try {
      if (reason === "closed") window.isDestroyed = () => true;
      else window.isVisible = () => false;
      window.emit(reason === "closed" ? "closed" : "hide");
      controller.unregisterNativeWindowDragTarget(reason);
      await settle();
      assert.equal(controller.codexPetOverlayKWinDragState, null);
      assert.equal(controller.codexPetOverlayKWinPosition, null);
      assert.equal(controller.nativeWindowDragActive, false);
      assert.equal(bridgeCalls.filter(op => op === "stop").length, 1);
      const bounds = { ...pet.frameGeometry };
      workspace.cursorPos.x += 100; cursorSignal.emit();
      assert.deepEqual({ ...pet.frameGeometry }, bounds);
      assert.equal(hintRequests, 0, "hidden and closed windows must not schedule compositor hints");
      controller.unregisterNativeWindowDragTarget(reason);
      await settle();
      assert.equal(bridgeCalls.filter(op => op === "stop").length, 1, "interrupt cleanup must run once");
    } finally {
      controller.codexPetOverlayEndKWinDrag(window);
    }
  });
}

test("a new mascot drag finishes the previous gesture in the same KWin session", async () => {
  const scenario = kwinMascotDragScenario();
  try {
    scenario.start(); await settle();
    const bridge = scenario.controller.codexPetOverlayKWinBridge;
    scenario.start();
    await settle();
    assert.equal(scenario.controller.codexPetOverlayKWinBridge, bridge);
    assert.deepEqual(scenario.bridgeCalls.filter(op => ["drag", "endDrag"].includes(op)), ["drag", "endDrag", "drag"]);
    await scenario.end();
  } finally {
    scenario.controller.unregisterNativeWindowDragTarget("hidden");
  }
});

for (const variant of ["missing", "foreign-owner"]) test(`native drag cleanup fails closed: ${variant}`, () => {
  let source = currentAvatarOverlayBundleFixture().replace("unregisterNativeWindowDragTarget(e){", "otherNativeCleanup(e){");
  if (variant === "foreign-owner") source += "class Other{unregisterNativeWindowDragTarget(e){try{}finally{}}}";
  const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source));
  assert.equal(result, source);
  assert.match(warnings.join("\n"), /Pet overlay patch is incomplete/);
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

for (const [desktop, ozonePlatform, nativeKWin, kwin = true] of [
  ["KDE", "wayland", true], ["KDE", "x11", false], ["niri", "wayland", false], ["Hyprland", "wayland", false],
  ["KDE", "wayland", false, false],
]) test(`overlay drag regions select one gesture owner: ${desktop} ${ozonePlatform} kwin=${kwin}`, () => {
  const inserted = [], handlers = {};
  const { controller } = controllerFromPatchedSource(applyPetOverlayPatch(currentAvatarOverlayBundleFixture(), {
    feature: { settings: { petOverlay: { kwin } } },
  }), {
    ozonePlatform, process: { env: { XDG_CURRENT_DESKTOP: desktop } },
  });
  controller.codexPetOverlayInstallTransparentRenderer({ webContents: {
    insertCSS: css => inserted.push(css), isDestroyed: () => false,
    on: (event, callback) => { handlers[event] = callback; },
  } });
  handlers["did-finish-load"]();
  assert.equal(inserted.length, 2);
  for (const css of inserted) {
    if (nativeKWin) {
      assert.match(css, /html,body,#root,#root \*\{-webkit-app-region:no-drag!important;app-region:no-drag!important;\}/);
      assert.doesNotMatch(css, /app-region:drag/,
        "Chromium drag regions must not start a second native KWin move that bypasses the renderer gesture");
    } else {
      assert.match(css, /-webkit-app-region:drag!important/);
      assert.doesNotMatch(css, /#root \*\{/);
    }
  }
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

  // Upstream now creates the overlay non-focusable on every platform; passive
  // mode keeps it that way instead of restoring focusability after show.
  assert.match(
    patched,
    /appearance:"avatarOverlay",frame:process\.platform===`linux`\?!1:!0,supportsWindowTiling:!1,focusable:!1/,
  );
  assert.match(patched, /codexPetOverlaySettings\(\)\{let e=\{[^}]*mode:`passive`/);
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
    getContentBounds: () => ({ x: 100, y: 100, width: 356, height: 320 }),
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
    { x: controller.anchor.x, y: controller.anchor.y },
    { x: 150, y: 100 },
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
          callback(null, args.includes("org.kde.kwin.Scripting.loadScript") ? "0\n" : "ok");
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
          return "0\n";
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
  assert.equal(controller.codexPetOverlayKWinDragState, null);
  controller.codexPetOverlayBeginKWinDrag(window);
  assert.equal(calls, 2);
});

test(
  "main-process patch changes exactly one current signed chunk and stays idempotent",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
    const chunks = fs.readdirSync(buildDir).filter(name => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name));
    const context = { feature: { manifest: JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8")), settings: {} } };
    const changed = [];
    for (const name of chunks) {
      const source = fs.readFileSync(path.join(buildDir, name), "utf8");
      const { result, warnings } = captureWarnings(() => applyPetOverlayPatch(source, context));
      if (result === source) {
        assert.ok(warnings.length > 0, name);
        continue;
      }
      assert.deepEqual(warnings, [], name);
      new vm.Script(result, { filename: name });
      const again = captureWarnings(() => applyPetOverlayPatch(result, context));
      assert.equal(again.result, result);
      assert.deepEqual(again.warnings, []);
      changed.push(name);
    }
    assert.equal(changed.length, 1);
  },
);
