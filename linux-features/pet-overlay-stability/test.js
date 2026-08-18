#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const {
  acceptsNativeBounds,
  applyPetOverlayStabilityPatch,
  capFlingVelocity,
  clipInputShape,
  createLatestWinsScheduler,
  descriptors,
  findOverlayClass,
} = require("./patch.js");

const TICK = String.fromCharCode(96);

function writeConfig(enabled) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-overlay-stability-"));
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled }) + "\n");
  return { root, configPath };
}

function officialOverlayFixture() {
  return [
    "var Overlay=class{",
    "windowManager;globalState;window=null;displayBounds=null;displayId=null;dragState=null;layout=null;layoutMode=\"legacy\";hasDeferredLayout=!1;mascotSize={width:112,height:112};momentumActive=!1;momentumTimer=null;pendingElementSizeRevision=null;movedWindowPersistTimer=null;mousePassthroughEnabled=!1;inputShape=null;pointerInteractive=!1;rendererReady=!0;lastSentRendererState=null;realtimeCaptionAboveMascotPx=0;traySize=null;placement=\"top-end\";presentationOffset={x:0,y:0};nativeCompositionSupported=!1;nativeCompositionEnabled=!1;",
    "handleDisplayChanged=()=>{if(this.isSuspended)return;this.cancelMomentum()};",
    "handleSuspend=()=>{let e=this.window;if(e==null)return;this.cancelMomentum()};",
    "handleResume=()=>{this.isSuspended=!1;};",
    "startDrag(e,t,n=!1){let r=this.window;if(r==null||r.isDestroyed()||r.webContents.id!==e)return;this.cancelMomentum();this.windowServerDragActive=!1;this.windowServerDragWindowX=r.getContentBounds().x;let i=this.getLayout(r);let a=J5(this.compositionHost.getCursorPosition()),o=t.pointerScreenX!=null&&t.pointerScreenY!=null?{x:t.pointerScreenX,y:t.pointerScreenY}:l.screen.getCursorScreenPoint(),s=a??o,c=t.pointerWindowX-i.mascot.left,u=t.pointerWindowY-i.mascot.top;this.dragState=new aOe(a==null?\"renderer\":\"native\",c,u,l.screen.getDisplayNearestPoint(s).bounds);this.windowServerDragActive=this.layoutMode===\"native\"&&!n&&this.compositionHost.performWindowDrag();this.windowServerDragActive||(this.windowServerDragWindowX=null)}",
    "moveDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e||this.dragState==null)return;this.cancelMomentum();let r=this.dragState;if(r.recordMovementIntent(),this.windowServerDragActive)return;let i=l.screen.getCursorScreenPoint(),a=r.getCursorPointForSource({native:r.cursorSource===\"native\"?J5(this.compositionHost.getCursorPosition()):null,renderer:{x:t?.pointerScreenX??i.x,y:t?.pointerScreenY??i.y}});a!=null&&this.moveDragToPointer(n,a)}",
    "endDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;let r=this.dragState,i=this.windowServerDragActive,a=null;if(i&&r!=null){let e=J5(this.compositionHost.getCursorPosition())??(t==null?l.screen.getCursorScreenPoint():{x:t.pointerScreenX,y:t.pointerScreenY}),i=l.screen.getDisplayNearestPoint(e),o={...this.anchor,x:e.x-r.pointerAnchorX,y:e.y-r.pointerAnchorY};a=i,this.updateWindowServerDragPlacement(n,n.getContentBounds(),o,i,!0),this.sendWindowServerDragDirection(n,null)}else if(r?.hasMovementIntent){let e=l.screen.getCursorScreenPoint(),i=r.getCursorPointForSource({native:r.cursorSource===\"native\"?J5(this.compositionHost.getCursorPosition()):null,renderer:{x:t?.pointerScreenX??e.x,y:t?.pointerScreenY??e.y}});i!=null&&this.moveDragToPointer(n,i)}this.dragState=null,this.windowServerDragActive=!1,this.windowServerDragWindowX=null,i?this.persistWindowBounds(n,a??this.getCurrentDisplay()):this.reclampWindowToVisibleDisplay({shouldPersist:!0});let o=this.dockTarget,s=kOe(this.anchor,this.presentationOffset);o!=null&&I5({current:s,next:s,target:{x:o.anchor.centerX,y:o.anchor.centerY}}).shouldDock&&this.dockPresentation(o.anchor,o.onDock)}",
    "throwWithVelocity(e,t,n,r=!1){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e||!Number.isFinite(t)||!Number.isFinite(n)||t===0&&n===0)return;this.startMomentum(t,n,r)}",
    "startMomentum(e,t,n){this.cancelMomentum();this.momentumActive=!0}",
    "cancelMomentum(){this.momentumTimer=null}",
    "setElementSize(e,{elementSizeRevision:t,isGlobalRealtimeVoiceTransitioning:r,isTrayVisible:i,mascot:a,nativeCompositionEnabled:o,petControlsAppearance:s,realtimeCaptionAboveMascotPx:c=0,showsVoiceControls:l=!1,tray:u}){this.pendingElementSizeRevision=t;this.mascotSize=a;this.traySize=u;this.applyLatestElementSizes(e)}",
    "applyLatestElementSizes(e){let t=this.pendingElementSizeRevision;this.pendingElementSizeRevision=null;this.applyLayout(e,this.getCurrentDisplay(),!1,!0,t)}",
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1,r=!0,i=null){let a=this.getLayoutForDisplay(t);this.displayId=t.id;this.resolutionKey=Y5(t.bounds);this.displayBounds=t.bounds;this.anchor=a.anchor;this.layout=a;this.placement=a.placement;this.setWindowBounds(e,a.windowBounds,n,r);this.compositionHost.updateMascotRect(a.mascot,a.placement);this.sendLayoutToRenderer(e,i)}",
    "getLayoutForDisplay(e){return{anchor:this.anchor,windowBounds:{x:this.anchor.x,y:this.anchor.y,width:384,height:400},mascot:{left:0,top:0,width:this.mascotSize.width,height:this.mascotSize.height},placement:this.placement}}",
    "setWindowBounds(e,t,n,r){e.setContentBounds(t)}",
    "getCurrentDisplay(){return l.screen.getDisplayNearestPoint(l.screen.getCursorScreenPoint())}",
    "restoreBoundsForDisplay(e,t){this.anchor=e}",
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null)return;if(this.applyInputShape(e))return}",
    "applyInputShape(e){if(!this.supportsInputShape||this.inputShape==null)return!1;let t=r.M(e,this.inputShape.map(({height:e,left:t,top:n,width:r})=>({height:e,width:r,x:t,y:n})));return t}",
    "setInputShape(e,t){if(!this.supportsInputShape)return;let n=this.window;n==null||n.isDestroyed()||n.webContents.id!==e||(this.inputShape=t,this.applyPointerInteractivityPolicy())}",
    "rememberMovedWindow(e){this.movedWindowPersistTimer=setTimeout(()=>{},100)}",
    "sendLayoutToRenderer(e,t=null){if(e.isDestroyed()||this.layout==null||!this.rendererReady)return}",
    "getLayout(e){return this.layout??this.applyLayout(e),this.layout}",
    "persistWindowBounds(e,t=this.getCurrentDisplay()){this.persisted=(this.persisted||0)+1}",
    "resetToDefaultAnchor(e){this.anchor={x:e.bounds.x,y:e.bounds.y,width:this.mascotSize.width,height:this.mascotSize.height}}",
    "clearMovedWindowPersist(){this.movedWindowPersistTimer=null}",
    "async createWindow(){let e=await this.windowManager.createWindow({title:l.app.getName(),width:384,height:400,appearance:" + TICK + "avatarOverlay" + TICK + ",show:!1}),t=e.webContents.id;return this.window=e,this.lastSentRendererState=null,e.on(" + TICK + "close" + TICK + ",()=>{this.window===e&&(this.cancelMomentum(),this.foo())}),e.on(" + TICK + "move" + TICK + ",()=>{if(!this.nativePositionController.handleWindowMove(e)){this.rememberMovedWindow(e)}}),e.on(" + TICK + "will-move" + TICK + ",()=>{this.cancelMomentum()}),e.on(" + TICK + "hide" + TICK + ",()=>{if(this.window===e)this.window.hide()}),e.on(" + TICK + "closed" + TICK + ",()=>{if(this.window!==e)return;this.window=null}),e}",
    "functionDoesNotMatter=()=>{};",
    "getDevelopmentDiagnostics(e=" + TICK + "include" + TICK + "){return{layout:layoutAlias(this.layout)}}",
    "};",
    "function message(){return " + TICK + "avatar-overlay-element-size-changed" + TICK + "}",
  ].join("");
}

function renamedAliasFixture() {
  return officialOverlayFixture()
    .replace(/\bJ5\b/g, "cursorAlias")
    .replace(/\baOe\b/g, "dragStateAlias")
    .replace(/\bkOe\b/g, "dockingAlias")
    .replace(/\bI5\b/g, "dockingDecisionAlias")
    .replace(/\bY5\b/g, "resolutionAlias")
    .replace(/\br\.M\b/g, "shapeAlias")
    .replace(/\bl\b/g, "screenAlias");
}

function writeAndLoadDescriptors(enabled) {
  const config = writeConfig(enabled);
  try {
    return loadLinuxFeaturePatchDescriptors({
      featuresRoot: path.join(__dirname, ".."),
      featuresConfigPath: config.configPath,
    });
  } finally {
    fs.rmSync(config.root, { recursive: true, force: true });
  }
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, delay), callback });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  tick(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due == null) {
        break;
      }
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }

  get size() {
    return this.timers.size;
  }
}

function withFakeClock(clock, callback) {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  Date.now = () => clock.now;
  global.setTimeout = clock.setTimeout;
  global.clearTimeout = clock.clearTimeout;
  try {
    return callback();
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

function findMethodText(source, name) {
  const overlay = findOverlayClass(source, false);
  const needle = name + "(";
  let start = overlay.open + 1;
  while (true) {
    start = source.indexOf(needle, start);
    if (start < 0 || start >= overlay.close) {
      break;
    }
    const previous = source[start - 1];
    if (previous != null && /[A-Za-z0-9_$./]/u.test(previous)) {
      start += needle.length;
      continue;
    }
    let depth = 0;
    let quote = null;
    let escaped = false;
    const openParen = start + name.length;
    let closeParen = -1;
    for (let index = openParen; index < overlay.close; index += 1) {
      const char = source[index];
      if (quote != null) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === TICK) quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) {
        closeParen = index;
        break;
      }
    }
    if (closeParen < 0) break;
    let bodyOpen = closeParen + 1;
    while (/\s/u.test(source[bodyOpen] ?? "")) bodyOpen += 1;
    if (source[bodyOpen] !== "{") {
      start = closeParen + 1;
      continue;
    }
    const bodyClose = findMatchingBrace(source, bodyOpen);
    return source.slice(start, bodyClose + 1);
  }
  throw new Error(`Missing test method ${name}`);
}

const RUNTIME_METHODS = [
  "codexPetOverlayStabilityData",
  "codexPetOverlayStabilityFinitePositive",
  "codexPetOverlayStabilityFiniteRect",
  "codexPetOverlayStabilityClone",
  "codexPetOverlayStabilityDisplayBounds",
  "codexPetOverlayStabilitySameGeometry",
  "codexPetOverlayStabilityClipInputShape",
  "codexPetOverlayStabilityBoundsSafe",
  "codexPetOverlayStabilityLayoutSafe",
  "codexPetOverlayStabilityClampAnchor",
  "codexPetOverlayStabilityClearGeometryTimer",
  "codexPetOverlayStabilityCancelDragWork",
  "codexPetOverlayStabilityCancelFling",
  "codexPetOverlayStabilityResetForWindow",
  "codexPetOverlayStabilityPrepareDrag",
  "codexPetOverlayStabilityBeginDrag",
  "codexPetOverlayStabilityQueueDragPoint",
  "codexPetOverlayStabilityFlushDrag",
  "codexPetOverlayStabilityFinishDrag",
  "codexPetOverlayStabilityApplySize",
  "codexPetOverlayStabilityNormalizeSize",
  "codexPetOverlayStabilityApplyPendingSize",
  "codexPetOverlayStabilityHandleSize",
  "codexPetOverlayStabilityRememberProgrammaticMove",
  "codexPetOverlayStabilityForgetProgrammaticMove",
  "codexPetOverlayStabilityConsumeProgrammaticMove",
  "codexPetOverlayStabilityRecordCommit",
  "codexPetOverlayStabilitySetClickThrough",
  "codexPetOverlayStabilityRememberStable",
  "codexPetOverlayStabilityRecover",
  "codexPetOverlayStabilityStartFling",
  "codexPetOverlayStabilityCancelForDisplayChange",
  "codexPetOverlayStabilityCancelTransient",
  "codexPetOverlayStabilityDiagnostics",
];

function createRuntimeHarness(patchedSource) {
  const classBody = RUNTIME_METHODS.map((name) => findMethodText(patchedSource, name)).join("\n");
  const moveDrag = findMethodText(patchedSource, "moveDrag");
  const cancelMomentum = findMethodText(patchedSource, "cancelMomentum");
  const setElementSize = findMethodText(patchedSource, "setElementSize");
  const throwWithVelocity = findMethodText(patchedSource, "throwWithVelocity");
  const applyInputShape = findMethodText(patchedSource, "applyInputShape");
  const applyPointerPolicy = findMethodText(patchedSource, "applyPointerInteractivityPolicy");
  const setInputShape = findMethodText(patchedSource, "setInputShape");
  const factory = new Function(
    "l",
    "J5",
    "aOe",
    "r",
    "Y5",
    `return class Harness{${classBody}\n${moveDrag}\n${cancelMomentum}\n${setElementSize}\n${throwWithVelocity}\n${applyInputShape}\n${applyPointerPolicy}\n${setInputShape}}`,
  );
  const pointer = { x: 100, y: 100 };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const shapeCalls = [];
  const electron = {
    screen: {
      getCursorScreenPoint: () => ({ ...pointer }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
    },
  };
  class DragState {
    constructor() {
      this.cursorSource = "renderer";
      this.displayBounds = display.bounds;
      this.hasMovementIntent = false;
      this.pointerAnchorX = 0;
      this.pointerAnchorY = 0;
    }

    recordMovementIntent() {
      this.hasMovementIntent = true;
    }

    getCursorPointForSource({ renderer }) {
      return renderer;
    }
  }
  const Harness = factory(
    electron,
    () => null,
    DragState,
    { M: (window, rectangles) => {
      shapeCalls.push({ window, rectangles });
      return true;
    } },
    (bounds) => `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`,
  );
  const window = {
    webContents: { id: 7 },
    destroyed: false,
    bounds: { x: 100, y: 100, width: 384, height: 400 },
    isDestroyed() {
      return this.destroyed;
    },
    getContentBounds() {
      return { ...this.bounds };
    },
    setContentBounds(bounds) {
      this.bounds = { ...bounds };
    },
    setIgnoreMouseEvents(value, options) {
      this.ignoreMouseEvents = { value, options };
    },
  };
  const overlay = new Harness();
  Object.assign(overlay, {
    window,
    displayBounds: display.bounds,
    displayId: display.id,
    mascotSize: { width: 112, height: 112 },
    anchor: { x: 100, y: 100, width: 112, height: 112 },
    layout: {
      windowBounds: window.bounds,
      mascot: { left: 0, top: 0, width: 112, height: 112 },
      placement: "top-end",
    },
    layoutMode: "native",
    rendererReady: true,
    supportsInputShape: true,
    inputShape: null,
    traySize: { width: 32, height: 32 },
    presentationOffset: { x: 0, y: 0 },
    compositionHost: { getCursorPosition: () => null },
    hasDeferredLayout: false,
    pendingElementSizeRevision: null,
    movedWindowPersistTimer: null,
    pendingElementSizeApplications: [],
    persistCount: 0,
    layoutCalls: [],
    dragCommits: [],
    pointerPolicyCalls: 0,
    clearMovedWindowPersist() {
      this.movedWindowPersistTimer = null;
    },
    getCurrentDisplay() {
      return display;
    },
    getLayout() {
      return this.layout;
    },
    applyLayout(targetWindow, targetDisplay) {
      this.codexPetOverlayStabilityOriginalApplyLayout(targetWindow, targetDisplay);
    },
    persistWindowBounds() {
      this.persistCount += 1;
    },
    moveDragToPointer(targetWindow, point) {
      this.dragCommits.push({ ...point });
      this.anchor = { ...this.anchor, x: point.x, y: point.y };
      targetWindow.bounds = { ...targetWindow.bounds, x: point.x, y: point.y };
    },
    codexPetOverlayStabilityOriginalSetElementSize(_id, message) {
      this.pendingElementSizeApplications.push(message);
    },
    codexPetOverlayStabilityOriginalCancelMomentum() {},
    codexPetOverlayStabilityOriginalApplyLayout(targetWindow, targetDisplay) {
      this.layoutCalls.push({ time: Date.now(), anchor: { ...this.anchor } });
      const bounds = targetDisplay.bounds;
      this.anchor = {
        ...this.anchor,
        x: Math.min(Math.max(this.anchor.x, bounds.x), bounds.x + bounds.width - this.mascotSize.width),
        y: Math.min(Math.max(this.anchor.y, bounds.y), bounds.y + bounds.height - this.mascotSize.height),
      };
      this.layout = {
        windowBounds: { x: this.anchor.x, y: this.anchor.y, width: 384, height: 400 },
        mascot: { left: 0, top: 0, width: this.mascotSize.width, height: this.mascotSize.height },
        placement: "top-end",
      };
      targetWindow.bounds = { ...this.layout.windowBounds };
    },
  });
  const upstreamPointerPolicy = overlay.applyPointerInteractivityPolicy.bind(overlay);
  overlay.applyPointerInteractivityPolicy = (...args) => {
    overlay.pointerPolicyCalls += 1;
    return upstreamPointerPolicy(...args);
  };
  overlay.codexPetOverlayStabilityResetForWindow(window);
  return { overlay, window, display, pointer, clock: new FakeClock(), shapeCalls, DragState };
}

function sizeMessage(revision, width) {
  return {
    elementSizeRevision: revision,
    mascot: { width, height: width },
    tray: { width: 32, height: 32 },
    isTrayVisible: true,
    nativeCompositionEnabled: false,
    showsVoiceControls: false,
  };
}

test("feature is disabled by default, conflicts with pet-overlay, and uses one required descriptor", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["main-process-stability", "main-bundle", "required-upstream"]],
  );
  assert.deepEqual(writeAndLoadDescriptors([]), []);
  assert.deepEqual(
    writeAndLoadDescriptors(["pet-overlay-stability"]).map(({ id }) => [id]),
    [["feature:pet-overlay-stability:main-process-stability"]],
  );
  assert.throws(
    () => writeAndLoadDescriptors(["pet-overlay", "pet-overlay-stability"]),
    /conflict|conflicting/i,
  );
});

test("pure geometry contracts reject malformed bounds and preserve click-through safety", () => {
  const capped = capFlingVelocity(2_800, 2_800);
  assert.ok(Math.abs(capped.x - 989.9494936611666) < 1e-9);
  assert.ok(Math.abs(capped.y - 989.9494936611666) < 1e-9);
  assert.deepEqual(capFlingVelocity(Number.NaN, 2), { x: 0, y: 0 });
  assert.equal(
    acceptsNativeBounds(
      { x: 0, y: 0, width: 384, height: 400 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ),
    true,
  );
  assert.equal(
    acceptsNativeBounds(
      { x: 0, y: 0, width: 385, height: 400 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ),
    false,
  );
  assert.equal(
    acceptsNativeBounds(
      { x: Number.NaN, y: 0, width: 384, height: 400 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ),
    false,
  );
  assert.deepEqual(
    clipInputShape(
      [
        { left: -10, top: 4, width: 20, height: 12 },
        { left: 100, top: 1, width: 2, height: 2 },
        { left: 2, top: 2, width: Number.NaN, height: 4 },
        { left: 2, top: 2, width: -1, height: 4 },
      ],
      { width: 16, height: 10 },
    ),
    [{ left: 0, top: 4, width: 10, height: 6 }],
  );
  assert.equal(clipInputShape([{ left: 0, top: 0, width: 10, height: 10 }], { width: 10, height: 10 })[0].width, 10);
  assert.equal(clipInputShape([{ left: 20, top: 20, width: 1, height: 1 }], { width: 10, height: 10 }), null);
});

test("latest-wins scheduler commits only the newest point and stale callbacks are inert", () => {
  const callbacks = [];
  const cancelled = new Set();
  const scheduler = createLatestWinsScheduler(
    (callback) => {
      callbacks.push(callback);
      return callback;
    },
    (callback) => cancelled.add(callback),
  );
  const committed = [];
  scheduler.onCommit = (value) => committed.push(value);
  for (let index = 0; index < 1_000; index += 1) scheduler.push(index);
  assert.equal(callbacks.length, 1);
  callbacks.shift()();
  assert.deepEqual(committed, [999]);
  scheduler.push("stale");
  const stale = callbacks.shift();
  scheduler.cancel();
  stale();
  assert.deepEqual(committed, [999]);
  assert.ok(cancelled.has(stale));
});

test("current semantic contract is applied exactly once and survives alias renaming", () => {
  const source = officialOverlayFixture();
  const patched = applyPetOverlayStabilityPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyPetOverlayStabilityPatch(patched), patched);
  new vm.Script(patched, { filename: "fixture-patched.js" });
  assert.match(patched, /codexPetOverlayStabilityPatchV2/);
  assert.match(patched, /codexPetOverlayStabilityData\(\)/);
  assert.match(patched, /setTimeout\([^)]*,16\)/);
  assert.match(patched, /linuxStability/);

  const renamed = applyPetOverlayStabilityPatch(renamedAliasFixture());
  new vm.Script(renamed, { filename: "fixture-renamed-patched.js" });
  assert.match(renamed, /screenAlias\.screen/);
  assert.match(renamed, /cursorAlias\(this\.compositionHost/);
  assert.match(renamed, /shapeAlias\(e/);
  assert.match(renamed, /resolutionAlias\(r\)/);
  assert.doesNotMatch(renamed.slice(renamed.indexOf("codexPetOverlayStabilityPatchV2")), /\b(?:J5|aOe|kOe|I5|Y5)\b/);
});

test("partial, duplicate, and drifted contracts fail closed", () => {
  const source = officialOverlayFixture();
  assert.throws(
    () => applyPetOverlayStabilityPatch(source.replace("avatarOverlay", "avatarOverlayDrift")),
    /avatar overlay class|appearance anchor/i,
  );
  assert.throws(
    () => applyPetOverlayStabilityPatch(source.replace("moveDrag(e,t)", "moveDragDrift(e,t)")),
    /moveDrag|current avatar overlay method/i,
  );
  assert.throws(
    () => applyPetOverlayStabilityPatch(source.replace("avatar-overlay-element-size-changed", "different-message")),
    /element-size/i,
  );
  const patched = applyPetOverlayStabilityPatch(source);
  assert.throws(
    () => applyPetOverlayStabilityPatch(patched.replace("codexPetOverlayStabilityPatchV2=!0;", "codexPetOverlayStabilityPatchV2=!0;codexPetOverlayStabilityPatchV2=!0;")),
    /partial|duplicate|mixed/i,
  );
  assert.throws(
    () => applyPetOverlayStabilityPatch(source.replace("var Overlay=class{", "var Overlay=class{codexPetOverlayStabilityPatchV2=!0;")),
    /partial|duplicate|mixed/i,
  );
  assert.throws(
    () => applyPetOverlayStabilityPatch(patched.replace("codexPetOverlayStabilityForgetProgrammaticMove(e){", "codexPetOverlayStabilityForgetProgrammaticMoveDrift(e){")),
    /partial|duplicate|mixed/i,
  );
});

test("synthetic overlay harness coalesces 1,000 drag events and drops stale callbacks", () => {
  const patched = applyPetOverlayStabilityPatch(officialOverlayFixture());
  const { overlay, window, pointer, clock, DragState } = createRuntimeHarness(patched);
  withFakeClock(clock, () => {
    overlay.dragState = new DragState();
    overlay.codexPetOverlayStabilityBeginDrag(window.webContents.id);
    for (let index = 0; index < 1_000; index += 1) {
      pointer.x = 100 + index;
      pointer.y = 200 + index;
      overlay.moveDrag(window.webContents.id, {
        pointerScreenX: pointer.x,
        pointerScreenY: pointer.y,
      });
    }
    assert.equal(clock.size, 1);
    clock.tick(15);
    assert.equal(overlay.dragCommits.length, 0);
    clock.tick(1);
    assert.equal(overlay.dragCommits.length, 1);
    assert.deepEqual(overlay.dragCommits[0], { x: 1_099, y: 1_199 });

    overlay.codexPetOverlayStabilityQueueDragPoint(window.webContents.id, { x: 1_200, y: 1_200 });
    overlay.codexPetOverlayStabilityFinishDrag(window.webContents.id);
    clock.tick(16);
    assert.equal(overlay.dragCommits.length, 1);

    overlay.dragState = new DragState();
    overlay.codexPetOverlayStabilityBeginDrag(window.webContents.id);
    overlay.codexPetOverlayStabilityQueueDragPoint(window.webContents.id, { x: 1_300, y: 1_300 });
    overlay.codexPetOverlayStabilityResetForWindow(window);
    clock.tick(16);
    assert.equal(overlay.dragCommits.length, 1);
  });
  assert.ok(overlay.codexPetOverlayStabilityData().coalescedDragMoves >= 998);
});

test("programmatic move acknowledgement consumes only matching asynchronous notifications", () => {
  const { overlay, window } = createRuntimeHarness(applyPetOverlayStabilityPatch(officialOverlayFixture()));
  const target = { x: 240, y: 260, width: 384, height: 400 };
  window.bounds = { ...target };
  overlay.codexPetOverlayStabilityRememberProgrammaticMove(target, window);
  assert.equal(overlay.codexPetOverlayStabilityConsumeProgrammaticMove(window), true);
  assert.equal(overlay.codexPetOverlayStabilityData().acknowledgedProgrammaticMoves, 1);
  window.bounds = { ...target, x: 500 };
  overlay.codexPetOverlayStabilityRememberProgrammaticMove(target, window);
  assert.equal(overlay.codexPetOverlayStabilityConsumeProgrammaticMove(window), false);
  assert.equal(overlay.codexPetOverlayStabilityData().programmaticMoves.length, 1);
});

test("size revisions are atomic during drag and cancel momentum when received during fling", () => {
  const { overlay, window } = createRuntimeHarness(applyPetOverlayStabilityPatch(officialOverlayFixture()));
  overlay.dragState = { cursorSource: "renderer" };
  const state = overlay.codexPetOverlayStabilityData();
  state.dragActive = true;
  state.rendererId = window.webContents.id;
  overlay.setElementSize(999, sizeMessage(79, 79));
  assert.equal(state.pendingSize, null);
  overlay.setElementSize(window.webContents.id, sizeMessage(80, 80));
  overlay.setElementSize(window.webContents.id, sizeMessage(112, 112));
  overlay.setElementSize(window.webContents.id, sizeMessage(224, 224));
  assert.equal(overlay.pendingElementSizeApplications.length, 0);
  assert.equal(state.pendingSize.revision, 224);
  overlay.codexPetOverlayStabilityFinishDrag(window.webContents.id);
  assert.deepEqual(overlay.pendingElementSizeApplications.map((message) => message.mascot.width), [224]);
  assert.equal(state.lastAppliedSizeRevision, 224);

  state.fling = { generation: 1 };
  state.geometryKind = "fling";
  overlay.setElementSize(window.webContents.id, sizeMessage(225, 225));
  assert.equal(state.fling, null);
  assert.equal(overlay.pendingElementSizeApplications.at(-1).mascot.width, 225);
});

test("fling remains capped, bounded, short, and bounces at most once", () => {
  const { overlay, window, clock } = createRuntimeHarness(applyPetOverlayStabilityPatch(officialOverlayFixture()));
  withFakeClock(clock, () => {
    overlay.anchor = { x: 100, y: 100, width: 112, height: 112 };
    overlay.codexPetOverlayStabilityStartFling(window.webContents.id, 100_000, 0, true);
    clock.tick(400);
  });
  assert.equal(overlay.codexPetOverlayStabilityData().fling, null);
  assert.equal(clock.size, 0);
  assert.ok(overlay.layoutCalls.length > 0);
  assert.ok(overlay.layoutCalls.every((entry, index) => {
    if (index === 0) return true;
    const previous = overlay.layoutCalls[index - 1];
    return Math.hypot(entry.anchor.x - previous.anchor.x, entry.anchor.y - previous.anchor.y) <= 24 + 1e-9;
  }));
  const directions = overlay.layoutCalls.slice(1).map((entry, index) => Math.sign(entry.anchor.x - overlay.layoutCalls[index].anchor.x)).filter(Boolean);
  let directionChanges = 0;
  for (let index = 1; index < directions.length; index += 1) {
    if (directions[index] !== directions[index - 1]) directionChanges += 1;
  }
  assert.ok(directionChanges <= 1);
  assert.ok(overlay.layoutCalls.at(-1).time <= 336);
  assert.equal(overlay.persistCount, 1);
});

test("invalid geometry triggers deterministic recovery and a new drag works immediately", () => {
  const { overlay, window, clock, DragState, shapeCalls } = createRuntimeHarness(applyPetOverlayStabilityPatch(officialOverlayFixture()));
  const state = overlay.codexPetOverlayStabilityData();
  state.stableLayout = {
    anchor: { x: 100, y: 100, width: 112, height: 112 },
    inputShape: [{ left: 0, top: 0, width: 112, height: 112 }],
    displayId: 1,
    displayBounds: overlay.displayBounds,
  };
  overlay.anchor = { x: 1_000_000, y: 1_000_000, width: 112, height: 112 };
  overlay.codexPetOverlayStabilityRecover(window, "invalid-layout");
  assert.equal(state.recoveries, 1);
  assert.equal(state.recovering, false);
  assert.equal(clock.size, 0);
  assert.equal(overlay.persistCount, 1);
  assert.equal(overlay.pointerPolicyCalls, 1);
  assert.deepEqual(shapeCalls.at(-1).rectangles, [{ height: 112, width: 112, x: 0, y: 0 }]);

  withFakeClock(clock, () => {
    overlay.dragState = new DragState();
    overlay.codexPetOverlayStabilityBeginDrag(window.webContents.id);
    overlay.codexPetOverlayStabilityQueueDragPoint(window.webContents.id, { x: 300, y: 300 });
    clock.tick(16);
  });
  assert.deepEqual(overlay.dragCommits, [{ x: 300, y: 300 }]);
});

test("input-shape fallback never promotes the transparent window to a full hit target", () => {
  const { overlay, window, shapeCalls } = createRuntimeHarness(applyPetOverlayStabilityPatch(officialOverlayFixture()));
  overlay.setInputShape(window.webContents.id, [
    { x: -20, y: -10, width: 40, height: 30 },
    { x: Number.NaN, y: 0, width: 20, height: 20 },
  ]);
  assert.deepEqual(overlay.inputShape, [{ left: 0, top: 0, width: 20, height: 20 }]);
  assert.deepEqual(shapeCalls.at(-1).rectangles, [{ height: 20, width: 20, x: 0, y: 0 }]);
  overlay.setInputShape(window.webContents.id, [{ x: 10_000, y: 10_000, width: 20, height: 20 }]);
  assert.deepEqual(shapeCalls.at(-1).rectangles, [{ height: 20, width: 20, x: 0, y: 0 }]);
  assert.notDeepEqual(shapeCalls.at(-1).rectangles, [{ height: 400, width: 384, x: 0, y: 0 }]);
});

test("teardown clears timers, generations, pending revisions, and move acknowledgements", () => {
  const { overlay, window, clock, DragState } = createRuntimeHarness(applyPetOverlayStabilityPatch(officialOverlayFixture()));
  withFakeClock(clock, () => {
    overlay.dragState = new DragState();
    overlay.codexPetOverlayStabilityBeginDrag(window.webContents.id);
    overlay.codexPetOverlayStabilityQueueDragPoint(window.webContents.id, { x: 330, y: 330 });
    overlay.codexPetOverlayStabilityRememberProgrammaticMove(window.bounds, window);
    overlay.codexPetOverlayStabilityHandleSize(window.webContents.id, sizeMessage(300, 224));
    overlay.codexPetOverlayStabilityCancelTransient(window);
    clock.tick(500);
  });
  const state = overlay.codexPetOverlayStabilityData();
  assert.equal(clock.size, 0);
  assert.equal(state.dragActive, false);
  assert.equal(state.fling, null);
  assert.equal(state.pendingSize, null);
  assert.deepEqual(state.programmaticMoves, []);
  assert.deepEqual(overlay.dragCommits, []);
});

const signedBundlePath = process.env.PET_OVERLAY_SIGNED_BUNDLE ?? "/home/frontstreet/.cache/pet-overlay-audit.current/.vite/build/main-Cw5W_AF8.js";
test(
  "the current signed 26.814.41957 bundle applies cleanly when available",
  { skip: !fs.existsSync(signedBundlePath) },
  () => {
    const source = fs.readFileSync(signedBundlePath, "utf8");
    const patched = applyPetOverlayStabilityPatch(source);
    new vm.Script(patched, { filename: "signed-patched-main.js" });
    assert.equal(applyPetOverlayStabilityPatch(patched), patched);
  },
);
