"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { applyPetOverlayGestureRendererPatch } = require("../patch.js");
const fixture = fs.readFileSync(require.resolve("./native-renderer-gesture.js"), "utf8");

module.exports = function rendererGesture({ native = true, complete = async () => true, dispatch = () => {} } = {}) {
  const messages = [], calls = [], warnings = [], clicks = [];
  class Element { closest() { return null; } }
  class HTMLElement extends Element {
    setPointerCapture() {}
    hasPointerCapture() { return false; }
  }
  let serial = 0;
  const context = {
    rA: { current: null }, Element, HTMLElement, iI: false, ir: false, a2: false, iM: null,
    oo() {}, rN() {}, aC: () => clicks.push(true), iF() {}, rM() {}, r1() {},
    o: { CodexAvatarOverlayAction: {}, CodexAvatarOverlaySource: {}, CodexMiniQuickChatOpenMethod: {} },
    tQ: { v: { debug() {} } },
    crypto: { randomUUID: () => `aaaaaaaa-aaaa-aaaa-aaaa-${String(++serial).padStart(12, "0")}` },
    console: { warn: (...args) => warnings.push(args) },
    G: { O1: { dispatchMessage(type, payload) { messages.push({ type, payload }); dispatch(type, payload); } } },
    tW: { appServices: { avatarOverlay: { codexPetOverlayCompleteDrag: (...args) => { calls.push(args); return complete(...args); } } } },
  };
  const patched = applyPetOverlayGestureRendererPatch(fixture);
  assert.equal(applyPetOverlayGestureRendererPatch(patched), patched);
  vm.runInNewContext(patched, context);
  context.receiveLayout({ layout: { codexPetOverlayNativeDrag: native } });
  const element = new HTMLElement();
  const event = { button: 0, pointerId: 1, target: element, currentTarget: element, preventDefault() {},
    clientX: 74, clientY: 74, screenX: 100, screenY: 100, timeStamp: 0, altKey: false };
  return { context, event, messages, calls, warnings, clicks,
    down: () => context.eC(event), up: released => context.rU({ ...event, timeStamp: 500 }, released ?? true) };
};
