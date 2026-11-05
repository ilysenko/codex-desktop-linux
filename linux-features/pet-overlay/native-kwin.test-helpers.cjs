"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { signal, session, bridgeForSession } = require("./fixtures/kwin-session.cjs");
const rendererGesture = require("./fixtures/renderer-gesture.cjs");
const settle = () => new Promise(resolve => setImmediate(resolve));

module.exports = function register({ controllerFromPatchedSource, applyPetOverlayPatch, nativePresentationBundleFixture }) {
  function scenario({ desktop = "KDE", ozonePlatform = "wayland", mode = "interactive", lockPosition = false, proximity = false, constructionFails = false } = {}) {
    const state = { visible: false, destroyed: false, focusable: false, width: 1920, height: 1200 };
    const calls = [], timers = [], errors = [], bridges = [], intervals = [];
    let active, physical = { x: 0, y: 0, width: 1920, height: 1200 };
    const mini = { pid: 4242, caption: "Codex Pet Overlay", resourceClass: "codex-desktop", wantsInput: true,
      internalId: "{60115083-b547-4bfe-b29f-3736ebcd996b}", frameGeometryChanged: signal(),
      get frameGeometry() { return physical; }, set frameGeometry(value) { physical = value; mini.frameGeometryChanged.emit(); } };
    const workspace = { windowAdded: signal(), windowRemoved: signal(), windowActivated: signal(), cursorPosChanged: signal(),
      cursorPos: { x: 100, y: 100 }, windowList: () => state.visible ? [mini] : [], raiseWindow() {},
      get activeWindow() { return active; }, set activeWindow(value) { active = value; workspace.windowActivated.emit(value); } };
    const kwin = session(workspace);
    let gate = async () => {};
    const SessionBridge = bridgeForSession(kwin, { calls, beforeCommand: (...args) => gate(...args) });
    class FakeBridge extends SessionBridge {
      constructor(options) { super(options); bridges.push(this); if (constructionFails) throw Error("Cannot create bridge directory"); }
    }
    const { controller } = controllerFromPatchedSource(applyPetOverlayPatch(nativePresentationBundleFixture()
      .replace("let e=tm(this.layout),t=e;", "let e=tm(this.layout),t=e;return t;"), {
      feature: { settings: { petOverlay: { mode, lockPosition } } },
    }), { ozonePlatform, process: { env: { XDG_CURRENT_DESKTOP: desktop } }, KWinBridge: FakeBridge,
      setTimeout: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
      setInterval: callback => { const timer = { callback, unref() {} }; intervals.push(timer); return timer; },
      clearInterval: timer => { timer.cancelled = true; },
      clearTimeout: timer => { if (timer) timer.cancelled = true; } });
    const window = Object.assign(new EventEmitter(), { webContents: { id: 1, focus() {} },
      isDestroyed: () => state.destroyed, isVisible: () => state.visible, isFocusable: () => state.focusable,
      getTitle: () => mini.caption, getContentBounds: () => ({ x: 0, y: 0, width: state.width, height: state.height }),
      setFocusable: value => { state.focusable = value; }, focus: () => { state.electronFocus = true; },
      show: () => { state.visible = true; }, showInactive: () => {
        if (!state.visible) { state.visible = true; workspace.activeWindow = mini; workspace.windowAdded.emit(mini); }
      }, hide: () => { state.visible = false; workspace.windowRemoved.emit(mini); window.emit("hide"); } });
    controller.window = window;
    controller.windowVisibilitySequence = 1;
    controller.visibilityMode = "on-demand";
    controller.codexPetOverlayDesiredWindowBounds = { x: 474, y: -244, width: 1920, height: 1200 };
    controller.shouldPresentWindow = () => true;
    controller.handleQuickChatKeyboardInteraction = () => {};
    controller.refreshNativeActiveAppearance = () => {};
    controller.applyPointerInteractivityPolicy = () => {};
    controller.realtimeController = { handlePresented() {} };
    controller.windowManager.setPendingAuxiliaryActivationTarget = () => {};
    controller.windowManager.sendMessageToWebContents = () => {};
    controller.codexPetOverlayScheduleKWinHints = () => {};
    if (!proximity) controller.updateCssPetControlsProximityTracking = () => {};
    controller.setPetPointerProximity = value => { state.near = value; };
    controller.logger = () => ({ debug() {}, info() {}, warning: (...args) => errors.push(args) });
    return { controller, window, workspace, mini, kwin, state, calls, timers, errors, bridges, intervals,
      gate: fn => { gate = fn; }, show: () => controller.showWindow(window) };
  }

  test("native presentation waits for its own prepare ACK, then maps at the saved position", async () => {
    const k = scenario(), other = { wantsInput: true };
    k.workspace.activeWindow = other;
    let release;
    k.gate(op => op === "prepare" ? new Promise(resolve => { release = resolve; }) : undefined);
    k.show(); k.show();
    await settle();
    assert.equal(k.state.visible, false);
    assert.equal(k.timers.length, 1);
    release(); await settle();
    assert.equal(k.state.visible, true);
    assert.deepEqual(JSON.parse(JSON.stringify(k.mini.frameGeometry)), k.controller.codexPetOverlayDesiredWindowBounds);
    assert.equal(k.workspace.activeWindow, other);
    assert.equal(k.state.electronFocus, undefined);
  });

  test("editor waits for pointer-policy ACK and later drags restore the external window", async () => {
    const k = scenario(), other = { wantsInput: true };
    k.workspace.activeWindow = other;
    k.show(); k.controller.setKeyboardInteraction(1, true);
    await settle();
    assert.deepEqual(k.calls, ["prepare", "pointer", "keyboard"]);
    assert.equal(k.workspace.activeWindow, k.mini);
    assert.equal(k.state.electronFocus, true);
    let restore;
    k.controller.handleQuickChatKeyboardInteraction = (_enabled, value) => { restore = value; };
    k.controller.setKeyboardInteraction(1, false, true);
    await settle();
    assert.equal(restore, false);
    k.workspace.activeWindow = other;
    k.workspace.activeWindow = k.mini;
    assert.equal(k.workspace.activeWindow, other);
  });

  for (const reason of ["hide", "closed", "replacement", "visibility-sequence", "no-intent"]) {
    test(`initial preparation cannot map a stale ${reason} window`, async () => {
      const k = scenario();
      let release;
      k.gate(op => op === "prepare" ? new Promise(resolve => { release = resolve; }) : undefined);
      k.show(); await settle();
      if (reason === "hide") k.window.hide();
      if (reason === "closed") { k.state.destroyed = true; k.window.emit("closed"); }
      if (reason === "replacement") k.controller.window = {};
      if (reason === "visibility-sequence") k.controller.windowVisibilitySequence += 1;
      if (reason === "no-intent") k.controller.shouldPresentWindow = () => false;
      release(); await settle();
      assert.equal(k.state.visible, false);
      assert.equal(k.controller.codexPetOverlayKWinPresentation, null);
    });
  }

  for (const reason of ["hide", "closed", "replacement", "visibility-sequence", "disabled"]) {
    test(`pointer-policy barrier cancels stale keyboard interaction: ${reason}`, async () => {
      const k = scenario(); k.show(); await settle();
      let release;
      k.gate(op => op === "pointer" ? new Promise(resolve => { release = resolve; }) : undefined);
      k.controller.setKeyboardInteraction(1, true); await settle();
      assert.equal(k.state.electronFocus, undefined);
      if (reason === "hide") k.window.hide();
      if (reason === "closed") { k.state.destroyed = true; k.window.emit("closed"); }
      if (reason === "replacement") k.controller.window = {};
      if (reason === "visibility-sequence") k.controller.windowVisibilitySequence += 1;
      if (reason === "disabled") k.controller.setKeyboardInteraction(1, false);
      k.gate(async () => {}); release(); await settle();
      assert.equal(k.state.electronFocus, undefined);
    });
  }

  test("initial placement re-arms changed bounds and preserves queued editor input", async () => {
    const k = scenario(); let release, first = true;
    k.gate(op => { if (op === "prepare" && first) { first = false; return new Promise(resolve => { release = resolve; }); } });
    k.show(); k.controller.setKeyboardInteraction(1, true); await settle();
    k.controller.codexPetOverlayDesiredWindowBounds = { ...k.controller.codexPetOverlayDesiredWindowBounds, x: 600 };
    release(); await settle();
    assert.equal(k.mini.frameGeometry.x, 600);
    assert.equal(k.workspace.activeWindow, k.mini);
  });

  test("rapid hide/show behind a pending command re-arms pointer policy after Stop", async () => {
    const k = scenario(); k.show(); await settle();
    let release;
    k.gate(op => op === "hints" ? new Promise(resolve => { release = resolve; }) : undefined);
    const pending = k.bridges[0].request("hints", k.controller.codexPetOverlayKWinData(k.window));
    const settled = Promise.allSettled([pending]);
    await settle();
    k.window.hide(); k.show(); k.controller.setKeyboardInteraction(1, true);
    await settle();
    k.gate(async () => {}); release(); await settled; await settle();
    assert.equal(k.calls.filter(op => op === "prepare").length, 2);
    assert.equal(k.state.visible, true);
    assert.equal(k.state.electronFocus, true);
    assert.ok(k.calls.indexOf("stop") < k.calls.lastIndexOf("prepare"));
  });

  test("preparation timeout remains visible and serializes late cleanup before keyboard mode", async () => {
    const k = scenario(); let release;
    k.gate(op => op === "prepare" ? new Promise(resolve => { release = resolve; }) : undefined);
    k.show(); k.controller.setKeyboardInteraction(1, true); await settle();
    k.timers[0].callback();
    assert.equal(k.state.visible, true);
    assert.equal(k.state.electronFocus, undefined);
    k.gate(async () => {}); release(); await settle();
    assert.equal(k.state.electronFocus, true);
  });

  for (const desktop of ["GNOME", "niri"]) test(`original on-demand activation is preserved on ${desktop}`, () => {
    const k = scenario({ desktop }); k.show();
    assert.equal(k.state.electronFocus, true);
    assert.deepEqual(k.calls, []);
  });

  for (const reason of ["X11", "GNOME", "passive", "hidden", "destroyed", "not-focusable"]) {
    test(`native keyboard activation is scoped: ${reason}`, async () => {
      const k = scenario({ ozonePlatform: reason === "X11" ? "x11" : "wayland",
        desktop: reason === "GNOME" ? "GNOME" : "KDE", mode: reason === "passive" ? "passive" : "interactive" });
      k.state.visible = reason !== "hidden";
      k.state.destroyed = reason === "destroyed";
      k.state.focusable = reason !== "not-focusable";
      assert.equal(await k.controller.codexPetOverlayActivateKWin(k.window), false);
      assert.deepEqual(k.calls, []);
    });
  }

  for (const reason of ["blur", "hide", "closed", "replacement", "changed-size", "disabled"]) {
    test(`queued keyboard command is cancelled before application: ${reason}`, async () => {
      const k = scenario(); k.show(); await settle();
      k.state.focusable = true;
      let release;
      k.gate(op => op === "keyboard" ? new Promise(resolve => { release = resolve; }) : undefined);
      const pending = k.controller.codexPetOverlayActivateKWin(k.window); await settle();
      if (reason === "blur") k.window.emit("blur");
      if (reason === "hide") k.window.hide();
      if (reason === "closed") { k.state.destroyed = true; k.window.emit("closed"); }
      if (reason === "replacement") k.controller.window = {};
      if (reason === "changed-size") k.state.width += 1;
      if (reason === "disabled") k.controller.codexPetOverlayKWinActivation.cancel();
      release(); assert.equal(await pending, false);
      for (const event of ["blur", "hide", "closed"]) assert.ok(k.window.listenerCount(event) <= 1);
    });
  }

  test("native proximity publishes actual rectangles without a global Electron cursor timer", async () => {
    const k = scenario(); k.show(); await settle();
    k.controller.showsPetControls = true;
    k.controller.petControlsProximityRects = [{ left: 200, top: 80, width: 30, height: 20 }];
    k.controller.petControlsAppearance = { proximityEnterDistance: 10, proximityExitDistance: 20 };
    k.controller.layout = { mascot: { left: 100, top: 80, width: 80, height: 80 } };
    k.controller.codexPetOverlayKWinProximity();
    await settle();
    k.workspace.cursorPos = { x: k.mini.frameGeometry.x + 195, y: k.mini.frameGeometry.y + 90 };
    k.workspace.cursorPosChanged.emit();
    assert.equal(k.kwin.events.at(-1).near, true, "click-through gap remains near the controls");
    assert.equal(k.controller.petControlsProximityTimer, undefined);
  });

  for (const constructionFails of [false, true]) test(`failed bridge restores upstream input and proximity; construction=${constructionFails}`, async () => {
    const k = scenario({ proximity: true, constructionFails });
    k.controller.showsPetControls = true;
    k.controller.layout = { mascot: { left: 10, top: 10, width: 80, height: 80 } };
    k.controller.petControlsProximityRects = [];
    k.controller.petControlsAppearance = { proximityEnterDistance: 10, proximityExitDistance: 20 };
    assert.doesNotThrow(k.show); await settle();
    if (!constructionFails) {
      k.bridges[0].fail(Error("KWin restarted"));
      await settle();
    }
    k.controller.setKeyboardInteraction(1, true); await settle();
    assert.equal(k.state.electronFocus, true);
    assert.equal(k.intervals.length, 1, "upstream proximity timer survives failed integration");
    for (let i = 0; i < 3; i += 1) k.controller.updateCssPetControlsProximityTracking();
    assert.equal(k.bridges.length, 1, "layout updates do not restart a failed bridge");
  });

  test("next show reconnects a failed bridge and hide invalidates the replacement", async () => {
    const k = scenario(); k.show(); await settle();
    const old = k.bridges[0]; old.fail(Error("lost ACK")); await settle();
    k.window.hide(); await settle();
    k.show(); await settle();
    assert.equal(k.bridges.length, 2);
    assert.equal(k.window.listenerCount("hide"), 1);
    const replacement = k.bridges[1], epoch = replacement.epoch;
    old.options.onNear(true);
    assert.notEqual(k.state.near, true, "old bridge events cannot change the replacement");
    k.window.hide(); await settle();
    assert.equal(replacement.epoch, epoch + 1);
  });

  for (const hide of [false, true]) test(`retry waits for old helper teardown before constructing a new bridge; hide=${hide}`, async () => {
    const k = scenario(); k.show(); await settle();
    let stopped;
    k.bridges[0].stopped = new Promise(resolve => { stopped = resolve; });
    k.bridges[0].fail(Error("ACK timeout")); k.window.hide(); await settle();
    k.show(); k.controller.setKeyboardInteraction(1, true); await settle();
    assert.equal(k.bridges.length, 1);
    assert.equal(k.state.electronFocus, undefined);
    if (hide) k.window.hide();
    stopped(); await settle();
    assert.equal(k.bridges.length, hide ? 1 : 2);
    assert.equal(k.state.electronFocus, hide ? undefined : true);
  });

  for (const hide of [false, true]) test(`failed pointer release waits for teardown before fallback focus; hide=${hide}`, async () => {
    const k = scenario(); k.show(); await settle();
    let stopped;
    k.bridges[0].stopped = new Promise(resolve => { stopped = resolve; });
    k.bridges[0].fail(Error("ACK timeout"));
    k.controller.setKeyboardInteraction(1, true); await settle();
    assert.equal(k.state.electronFocus, undefined);
    if (hide) k.window.hide();
    stopped(); await settle();
    assert.equal(k.state.electronFocus, hide ? undefined : true);
  });

  function dragScenario(options) {
    const k = scenario(options), c = k.controller;
    c.codexPetOverlayDesiredWindowBounds = { x: 300, y: 200, width: 1920, height: 1200 };
    c.anchor = { x: 350, y: 250, width: 80, height: 80 };
    c.layout = { anchor: c.anchor, mascot: { left: 50, top: 50, width: 80, height: 80 },
      windowBounds: c.codexPetOverlayDesiredWindowBounds, tray: null, placement: "top-end" };
    c.mascotSize = { width: 80, height: 80 };
    c.getLayoutForDisplay = (_display, anchor = c.anchor) => ({ ...c.layout, anchor: { ...anchor }, windowBounds: { ...k.mini.frameGeometry } });
    c.codexPetOverlayKWinFindWindow = () => ({ window: k.window, id: k.mini.internalId, bounds: { ...k.mini.frameGeometry } });
    c.codexPetOverlayKWinReadWindow = c.codexPetOverlayKWinFindWindow;
    const saved = [];
    c.persistWindowBounds = () => saved.push({ ...c.anchor });
    const layoutMessage = () => c.sendLayoutToRenderer();
    const start = gestureId => {
      k.workspace.cursorPos = { x: k.mini.frameGeometry.x + 74, y: k.mini.frameGeometry.y + 74 };
      c.startDrag(1, { pointerWindowX: 74, pointerWindowY: 74, pointerScreenX: k.workspace.cursorPos.x,
        pointerScreenY: k.workspace.cursorPos.y, codexPetOverlayGestureId: gestureId });
    };
    const renderer = () => rendererGesture({ native: layoutMessage().codexPetOverlayNativeDrag,
      complete: (id, alt, sample) => c.codexPetOverlayCompleteRendererDrag(1, id, alt, sample),
      dispatch(type, payload) {
        if (type === "avatar-overlay-drag-start") start(payload.codexPetOverlayGestureId);
        else if (type === "avatar-overlay-drag-end") c.endDrag(1, payload, payload.altKey);
      } });
    return { ...k, saved, start, renderer };
  }

  test("locked native mascot keeps its ordinary renderer click without starting a compositor gesture", async () => {
    const k = dragScenario({ lockPosition: true }); k.show(); await settle();
    const r = k.renderer(), bounds = { ...k.mini.frameGeometry };
    r.down(); await r.up(); await settle();
    assert.equal(r.clicks.length, 1);
    assert.equal(r.calls.length, 0);
    assert.equal(k.calls.includes("drag"), false);
    assert.deepEqual({ ...k.mini.frameGeometry }, bounds);
  });

  test("unmatched compositor and stale mascot hit bounds end the accepted upstream drag and keep its click", async () => {
    const k = dragScenario(); k.show(); await settle();
    k.controller.codexPetOverlayKWinFindWindow = () => null;
    k.controller.layout.mascot = { left: 100, top: 100, width: 80, height: 80 };
    const r = k.renderer(); r.down();
    assert.ok(k.controller.dragState);
    const drag = k.controller.dragState;
    assert.equal(k.controller.codexPetOverlayMascotDragState, undefined);
    await r.up();
    assert.equal(k.controller.dragState, null);
    assert.equal(r.clicks.length, 1);
    assert.equal(drag.hasMovementIntent, false, "a stationary fallback click is not a drag");
    assert.equal(k.calls.includes("drag"), false);
  });

  test("local fallback applies the final release sample before ending its gesture", async () => {
    const k = dragScenario(); k.show(); await settle();
    k.controller.codexPetOverlayKWinFindWindow = () => null;
    const r = k.renderer(); r.down();
    // Wayland's advisory screen position differs from KWin geometry; local coordinates remain valid.
    r.event.screenX += 76; r.event.screenY += 86;
    r.event.clientX = 150; r.event.clientY = 160;
    await r.up();
    assert.deepEqual({ ...k.controller.codexPetOverlayMascotLocalPosition }, { left: 126, top: 136 });
    assert.equal(k.controller.codexPetOverlayMascotDragState, null);
    assert.equal(r.clicks.length, 0);
    assert.deepEqual(r.messages.map(message => message.type), ["avatar-overlay-drag-start"]);
  });

  for (const alt of [false, true]) test(`stationary native click preserves snapped placement; Alt=${alt}`, async () => {
    const k = dragScenario(); k.show(); await settle();
    const c = k.controller, snap = { x: 350, y: 250 };
    c.isFreelyPositioned = false; c.snapPosition = snap;
    c.snapQuickChatToPosition = () => assert.fail("Alt-click must not perform a snap drag");
    c.animatePresentationTo = c.snapQuickChatToPosition;
    const r = k.renderer(); r.event.altKey = alt;
    r.down(); await settle(); await r.up();
    assert.equal(r.clicks.length, 1);
    assert.equal(c.isFreelyPositioned, false);
    assert.equal(c.snapPosition, snap);
    assert.equal(c.dragState, null);
    assert.equal(c.nativeWindowDragActive, false);
    assert.equal(c.codexPetOverlayKWinDragState, null);
    assert.equal(k.saved.length, 0);
  });

  test("stationary native release flushes a deferred content layout exactly once", async () => {
    const k = dragScenario(); k.show(); await settle();
    const c = k.controller, r = k.renderer();
    r.down(); await settle();
    const apply = c.applyLatestElementSizes.bind(c); let layouts = 0;
    c.applyLatestElementSizes = window => { layouts += 1; apply(window); };
    c.mascotSize = { width: 96, height: 88 };
    c.hasDeferredLayout = true;
    await r.up();
    assert.equal(layouts, 1);
    assert.equal(c.hasDeferredLayout, false);
    assert.equal(c.anchor.width, 96);
    assert.equal(c.anchor.height, 88);
    assert.equal(c.dragState, null);
    assert.equal(r.clicks.length, 1);
    assert.equal(k.saved.length, 0);
  });

  test("failed native release applies deferred content without saving unknown geometry or clicking", async () => {
    const k = dragScenario(); k.show(); await settle();
    const c = k.controller, r = k.renderer(), anchor = { ...c.anchor };
    r.down(); await settle();
    const apply = c.applyLatestElementSizes.bind(c); let layouts = 0;
    c.applyLatestElementSizes = window => { layouts += 1; apply(window); };
    c.mascotSize = { width: 96, height: 88 };
    c.hasDeferredLayout = true;
    k.bridges[0].fail(Error("ACK timeout"));
    await r.up();
    assert.equal(layouts, 1);
    assert.equal(c.hasDeferredLayout, false);
    assert.equal(c.anchor.width, 96);
    assert.equal(c.anchor.height, 88);
    assert.equal(c.anchor.x, anchor.x);
    assert.equal(c.anchor.y, anchor.y);
    assert.equal(c.dragState, null);
    assert.equal(r.clicks.length, 0);
    assert.equal(k.saved.length, 0);
  });

  test("renderer release cancels a gesture waiting for placement acknowledgement", async () => {
    const k = dragScenario(); k.show(); await settle();
    let release;
    k.gate(op => op === "hints" ? new Promise(resolve => { release = resolve; }) : undefined);
    k.controller.codexPetOverlayApplyKWinHints(k.window); await settle();
    const r = k.renderer(); r.down();
    assert.equal(k.controller.codexPetOverlayKWinDragState.pending, true);
    await r.up();
    k.gate(async () => {}); release(); await settle();
    assert.equal(r.clicks.length, 0, "an unconfirmed gesture cannot become a click");
    assert.equal(k.calls.includes("drag"), false);
    assert.equal(k.controller.codexPetOverlayKWinDragState, null);
    assert.equal(k.controller.nativeWindowDragActive, false);
    const bounds = { ...k.mini.frameGeometry };
    k.workspace.cursorPos.x += 100; k.workspace.cursorPosChanged.emit();
    assert.deepEqual({ ...k.mini.frameGeometry }, bounds);
  });

  for (const released of [false, true]) test(`renderer queues a distinct gesture until the previous release ACK; released=${released}`, async () => {
    const k = dragScenario(); k.show(); await settle();
    const r = k.renderer(); r.down(); await settle();
    k.workspace.cursorPos.x += 100; k.workspace.cursorPosChanged.emit();
    let release;
    k.gate(op => op === "endDrag" ? new Promise(resolve => { release = resolve; }) : undefined);
    const previous = r.up(); await settle();
    r.down();
    assert.notEqual(r.messages[0].payload.codexPetOverlayGestureId, r.messages[1].payload.codexPetOverlayGestureId);
    if (released) await r.up();
    assert.equal(k.calls.filter(op => op === "drag").length, 1);
    k.gate(async () => {}); release(); await previous; await settle();
    assert.equal(k.calls.filter(op => op === "drag").length, released ? 1 : 2);
    if (!released) await r.up();
    const bounds = { ...k.mini.frameGeometry };
    k.workspace.cursorPos.x += 100; k.workspace.cursorPosChanged.emit();
    assert.deepEqual({ ...k.mini.frameGeometry }, bounds);
    assert.equal(k.controller.nativeWindowDragActive, false);
    assert.equal(k.controller.codexPetOverlayKWinDragState, null);
  });

  test("duplicate and superseded releases cannot cancel a newer queued UUID", async () => {
    const k = dragScenario(), a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", c = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    k.show(); await settle(); k.start(a); await settle();
    let release;
    k.gate(op => op === "endDrag" ? new Promise(resolve => { release = resolve; }) : undefined);
    const endA = k.controller.codexPetOverlayCompleteRendererDrag(1, a, false); await settle();
    k.start(b); k.start(c);
    await assert.rejects(k.controller.codexPetOverlayCompleteRendererDrag(1, b, false), /Stale/);
    await assert.rejects(k.controller.codexPetOverlayCompleteRendererDrag(2, c, false), /Invalid/);
    const duplicateA = k.controller.codexPetOverlayCompleteRendererDrag(1, a, false);
    k.gate(async () => {}); release(); await Promise.all([endA, duplicateA]); await settle();
    assert.equal(k.controller.codexPetOverlayKWinDragState.rendererGestureId, c);
    assert.equal(k.calls.filter(op => op === "drag").length, 2);
    await k.controller.codexPetOverlayCompleteRendererDrag(1, c, false);
  });

  for (const moved of [false, true]) test(`renderer completion awaits compositor movement=${moved}`, async () => {
    const k = dragScenario(), id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    k.show(); await settle(); k.start(id); await settle();
    if (moved) { k.workspace.cursorPos.x += 100; k.workspace.cursorPosChanged.emit(); }
    let release, done = false;
    k.gate(op => op === "endDrag" ? new Promise(resolve => { release = resolve; }) : undefined);
    const result = k.controller.codexPetOverlayCompleteRendererDrag(1, id, false).then(value => { done = true; return value; });
    await settle(); assert.equal(done, false); assert.equal(k.saved.length, 0);
    release(); assert.equal(await result, moved); assert.equal(k.saved.length, moved ? 1 : 0);
    await assert.rejects(k.controller.codexPetOverlayCompleteRendererDrag(1, id, false), /Stale/);
  });

  test("renderer completion rejects foreign and stale gestures without ending the current drag", async () => {
    const k = dragScenario(), id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    k.show(); await settle(); k.start(id); await settle();
    for (const [caller, token, alt] of [[2, id, false], [1, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", false], [1, id, "false"]])
      await assert.rejects(k.controller.codexPetOverlayCompleteRendererDrag(caller, token, alt));
    for (const sample of [{}, { shouldMove: false, pointerScreenX: Infinity, pointerScreenY: 1 },
      { shouldMove: "false", pointerScreenX: 1, pointerScreenY: 1 },
      { shouldMove: false, pointerScreenX: 1, pointerScreenY: 1, pointerWindowX: 2 },
      { shouldMove: true, pointerScreenX: 1, pointerScreenY: 1, pointerWindowX: null, pointerWindowY: null }])
      await assert.rejects(k.controller.codexPetOverlayCompleteRendererDrag(1, id, false, sample));
    assert.equal(k.controller.codexPetOverlayKWinDragState.ending, undefined);
    assert.equal(k.calls.includes("endDrag"), false);
    await k.controller.codexPetOverlayCompleteRendererDrag(1, id, false);
  });

  test("controller persists actual geometry only after the endDrag ACK", async () => {
    const k = dragScenario(), id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    k.show(); await settle(); k.start(id); await settle();
    assert.equal(k.controller.codexPetOverlayKWinDragState.native, true);
    k.workspace.cursorPos = { x: 600, y: 400 }; k.workspace.cursorPosChanged.emit();
    let release;
    k.gate(op => op === "endDrag" ? new Promise(resolve => { release = resolve; }) : undefined);
    const completion = k.controller.codexPetOverlayCompleteRendererDrag(1, id, false); await settle();
    assert.equal(k.saved.length, 0);
    release(); await completion;
    assert.equal(k.saved.length, 1);
    assert.equal(k.saved[0].x, 576); assert.equal(k.saved[0].y, 376);
    assert.equal(k.controller.codexPetOverlayKWinDragState, null);
  });

};
