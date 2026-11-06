"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { findMatchingBrace } = require("../../../scripts/patches/lib/minified-js.js");
const ID = "[A-Za-z_$][\\w$]*";

function required(pattern, source, label) {
  const match = pattern.exec(source);
  assert.ok(match, label);
  return match;
}

function method(source) {
  const signatures = [...source.matchAll(/getLayoutForDisplay\([^{}]*\)\{/gu)];
  assert.equal(signatures.length, 1);
  const head = signatures[0];
  const end = findMatchingBrace(source, head.index + head[0].length - 1);
  assert.ok(end > head.index);
  return { start: head.index, end: end + 1, text: source.slice(head.index, end + 1) };
}

function innerFunction(source) {
  const head = required(/function\(\{anchor:[A-Za-z_$][\w$]*,constrainNativeDrawWindowToDisplay:/u,
    source, "native inner draw function");
  const params = head.index + "function(".length;
  const paramsEnd = findMatchingBrace(source, params);
  assert.equal(source.slice(paramsEnd + 1, paramsEnd + 3), "){");
  const end = findMatchingBrace(source, paramsEnd + 2);
  assert.ok(end > paramsEnd);
  return { start: head.index, end: end + 1, text: source.slice(head.index, end + 1) };
}

function rectangleIntersection(window, area) {
  const x = Math.max(window.x, area.x), y = Math.max(window.y, area.y);
  return {
    left: x - window.x,
    top: y - window.y,
    width: Math.max(0, Math.min(window.x + window.width, area.x + area.width) - x),
    height: Math.max(0, Math.min(window.y + window.height, area.y + area.height) - y),
  };
}

// Execute the actual outer layout body. Its inner draw function and imported
// geometry collaborators are inert, so this tests forwarding, post-processing
// and manager receiver ownership without app, compositor or native IPC work.
function runtime(nativeMethod, selectedMethod, { platform, ozone = "", kwin = false, manager, displays }) {
  const outer = required(/function\(\{display:[^{}]+\}\)\{/u, nativeMethod, "outer pure layout parameters");
  const fields = Object.fromEntries(outer[0].slice("function({".length, -3).split(",").map(field => field.split(":")));
  const display = fields.display, mode = fields.layoutMode;
  const remote = fields.remoteHostedPIPContentLayoutState, controls = fields.quickChatControls;
  const inner = innerFunction(selectedMethod);
  const instrumented = selectedMethod.slice(0, inner.start) +
    "function(codexTestOptions){return codexTestNativeLayout(codexTestOptions)}" + selectedMethod.slice(inner.end);
  const bounds = required(new RegExp(`(?:let |,)${ID}=(${ID})\\(${display},${mode}\\)`, "u"), nativeMethod, "native display rectangle")[1];
  const pip = required(new RegExp(`(?:let |,)${ID}=(${ID})\\(${remote}\\)`, "u"), nativeMethod, "remote PIP size")[1];
  const intersection = required(/workArea:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.windowBounds,/u,
    nativeMethod, "native rectangle intersection")[1];
  const clamp = required(/\.tray\.left=([A-Za-z_$][\w$]*)\(\)\(/u, nativeMethod, "native tray clamp")[1];
  const namespace = required(/petControlRowHeight:null!=[A-Za-z_$][\w$]*\?([A-Za-z_$][\w$]*)\./u,
    nativeMethod, "native control dimensions")[1];
  const width = required(new RegExp(`\\(0,${namespace}\\.(${ID})\\)\\(${controls}\\?\\.hasNotifications`, "u"),
    nativeMethod, "native Quick Chat width")[1];
  const mascot = required(/nativeDrawMascotSize:[A-Za-z_$][\w$]*\?void 0:([A-Za-z_$][\w$]*),/u,
    nativeMethod, "native draw mascot size")[1];
  const tray = required(/traySize:[A-Za-z_$][\w$]*\?\?\("native"===[A-Za-z_$][\w$]*\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*)\)/u,
    nativeMethod, "native tray defaults");
  const viewport = required(/viewportSize:"native"===[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\?\{\.\.\.([A-Za-z_$][\w$]*),/u,
    nativeMethod, "native viewport default")[1];
  const screen = required(/displays:([A-Za-z_$][\w$]*)\.screen\.getAllDisplays\(\)/u,
    nativeMethod, "native display enumeration")[1];
  const options = [], events = [];
  const kwinBounds = { x: 40, y: 50, width: 900, height: 700 };
  let finalLayout;
  const globals = {
    process: { platform },
    require(name) {
      assert.equal(name, "electron");
      return { app: { commandLine: { getSwitchValue: () => ozone } } };
    },
    codexTestNativeLayout(value) {
      events.push("native-layout");
      options.push(value);
      return {
        anchor: { ...value.anchor, x: value.anchor.x + 5, y: value.anchor.y + 7 },
        mascot: { left: 30, top: 40, width: value.mascotSize.width, height: value.mascotSize.height },
        placement: value.previousPlacement,
        tray: value.traySize == null ? null : { left: 100, top: 300, ...value.traySize },
        windowBounds: { x: 100, y: 200, width: 1200, height: 900 },
      };
    },
    [bounds]: (value, selectedMode) => selectedMode === "native" ? value.workArea : value.bounds,
    [pip]: state => state == null ? null : { width: 120, height: 80 },
    [intersection]: rectangleIntersection,
    [clamp]: () => (value, low, high) => Math.max(low, Math.min(value, high)),
    [namespace]: new Proxy({}, { get: (_target, key) => key === width ? () => 160 : 16 }),
    [mascot]: { width: 112, height: 87 },
    [tray[1]]: { width: 276, height: 131 },
    [tray[2]]: { width: 200, height: 100 },
    [viewport]: { width: 384, height: 400 },
    [screen]: { screen: { getAllDisplays: () => displays } },
  };
  const Controller = vm.runInNewContext(`(class{${instrumented}})`, globals);
  const controller = Object.assign(new Controller(), manager);
  controller.codexPetOverlayIsNativeKWin = function () {
    assert.equal(this, controller);
    return platform === "linux" && ozone === "wayland" && kwin;
  };
  controller.codexPetOverlayKWinDrawBounds = function () {
    assert.equal(this, controller);
    events.push("kwin-draw-bounds");
    return kwinBounds;
  };
  controller.codexPetOverlayKWinLayoutOptions = function (value, layout) {
    assert.equal(this, controller);
    assert.equal(typeof layout, "function");
    events.push("layout-options");
    return value;
  };
  controller.codexPetOverlayKWinLayout = function (display, value) {
    assert.equal(this, controller);
    assert.equal(display, displays[0]);
    events.push("layout-final");
    finalLayout = value;
    return value;
  };
  return { controller, options, events, kwinBounds, finalLayout: () => finalLayout };
}

module.exports = { method, innerFunction, runtime };
