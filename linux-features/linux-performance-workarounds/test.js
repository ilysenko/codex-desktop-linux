"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyLinuxAppShellTabLayoutPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
} = require("./implementation.js");

function currentAppShellTabLayoutFixture() {
  return [
    "function o9a(){let re=(e,t)=>{K(t.scrollWidth>t.clientWidth)},ie=$I(re),ye=L&&M!=null&&(q?`@max-[4rem]/app-shell-tab:pe-5`:`@max-[4rem]/app-shell-tab:group-hover/tab:pe-5`);return jsx(`button`,{\"data-app-shell-tab-close-button\":!0})}",
    "function m9a(){let M=!0,Ae=M?_9a:void 0,je=!1,Me=M?_9a:!1,Oe={maxWidth:`160px`,minWidth:`90px`},Ie={},Le={},Re=()=>{},Ee=`@container/app-shell-tab`;return jsx(kf.div,{animate:Oe,\"data-app-shell-tab-controller\":ke,\"data-tab-id\":V,exit:Ae,inert:je,initial:Me,style:Ie,transition:Le,onAnimationComplete:Re})}",
    "var _9a={maxWidth:`0px`,minWidth:`0px`};",
  ].join("");
}

test("linux-performance-workarounds remains an opt-in renderer-only feature", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id, phase }) => [id, phase]),
    [
      ["sidebar-scroll", "webview-asset"],
      ["app-shell-tab-layout", "webview-asset"],
      ["markdown-animation", "webview-asset"],
    ],
  );
});

test("current app-shell tab workaround disables mount animation and defers overflow measurement", () => {
  const source = currentAppShellTabLayoutFixture();
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), true);

  const patched = applyLinuxAppShellTabLayoutPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxScheduleAppShellTabOverflow\(t,K\)/u);
  assert.match(patched, /,Me=!1,/u);
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(patched), true);
  assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(patched), patched);
});

test("app-shell tab workaround fails closed when the current mount contract drifts", () => {
  const source = currentAppShellTabLayoutFixture().replace("initial:Me", "initial:!1");
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), false);
  assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(source), source);
});
