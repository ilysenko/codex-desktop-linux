"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxMarkdownAnimationPerformanceContract,
} = require("./implementation.js");

function currentAppShellTabLayoutFixture() {
  return "function tabs(){let map=new Map,Qe=(e,t)=>{let{key:n}=e,r=map.get(n);return r==null?null:jsx(Tab,{...t,activateOnClick:!0,animateLayout:!r.isWorkspaceHome&&t.animateLayout,animateExit:!r.isWorkspaceHome&&t.animateExit,closeButtonTabIndex:-1,controller:C,dragActivator:`tab`,tab:r,shortcutHint:null})};return Qe}";
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
  assert.equal(descriptors[0].pattern.test("app-primary-a0bff570446b.js"), false);
  assert.equal(descriptors[0].pattern.test("app-initial-cccb87527a41.js"), true);
  assert.equal(descriptors[1].pattern.test("thread-app-shell-chrome-1cbe88398368.js"), true);
  assert.equal(descriptors[2].pattern.test("app-primary-a0bff570446b.css"), true);
  assert.equal(descriptors[2].pattern.test("app-initial-cccb87527a41.css"), true);
});

test("current app-shell tab workaround disables tab layout animation", () => {
  const source = currentAppShellTabLayoutFixture();
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), true);
  const patched = applyLinuxAppShellTabLayoutPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /animateLayout:!1,animateExit:!r\.isWorkspaceHome&&t\.animateExit/u);
  assert.doesNotThrow(() => new Function(patched));
  assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(patched), true);
  assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(patched), patched);
});

test("app-shell tab workaround fails closed for missing, duplicate, mixed, and partial owners", () => {
  const owner = currentAppShellTabLayoutFixture();
  const patched = applyLinuxAppShellTabLayoutPerformancePatch(owner);
  const renamed = owner.replaceAll("Qe", "Xe").replaceAll("map", "tabsById");
  const cases = [
    owner.replace("dragActivator:`tab`", "dragActivator:`panel`"),
    owner + renamed,
    patched + renamed,
    owner.replace("animateExit:!r.isWorkspaceHome&&t.animateExit", "animateExit:t.animateExit"),
  ];
  for (const source of cases) {
    assert.equal(matchesLinuxAppShellTabLayoutPerformanceContract(source), false);
    assert.equal(applyLinuxAppShellTabLayoutPerformancePatch(source), source);
  }
});

test("current Markdown animation workaround disables streaming fades", () => {
  const source = "._MarkdownRoot_wt3tt_184[data-markdown-animated] :is(._FadeIn_wt3tt_659,._HorizontalRule_wt3tt_327,._ListItem_wt3tt_124,._TableRow_wt3tt_543,._Blockquote_wt3tt_285){opacity:1;animation:_fade-in_wt3tt_1 var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) both;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_wt3tt_184[data-markdown-animated] ._FadeListDecoration_wt3tt_666::marker{animation:_fade-in-marker_wt3tt_1 var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_wt3tt_184[data-markdown-animated] ._ImageEnter_wt3tt_672{transform-origin:50%;animation:.18s ease-out both _image-enter_wt3tt_1}";

  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(source), true);
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /FadeIn_wt3tt_659[^{}]*\{opacity:1;animation:none\}/u);
  assert.match(patched, /FadeListDecoration_wt3tt_666::marker\{animation:none\}/u);
  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(patched), true);
  assert.equal(applyLinuxMarkdownAnimationPerformancePatch(patched), patched);
});

test("current adaptive-streaming rules are preserved between the patched fade rules", () => {
  const source = "._MarkdownRoot_qhsrt_2[data-markdown-animated] :is(._FadeIn_qhsrt_2,._HorizontalRule_qhsrt_2,._ListItem_qhsrt_2,._TableRow_qhsrt_2,._Blockquote_qhsrt_2){opacity:1;animation:_fade-in_qhsrt_2 var(--duration) both;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_qhsrt_2[data-markdown-animated] ._FadeListDecoration_qhsrt_2::marker{animation:_fade-in-marker_qhsrt_2 var(--duration) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_qhsrt_2._AdaptiveStreaming_qhsrt_2 ._FadeIn_qhsrt_2{--duration:var(--animation-duration-streaming-text)}._MarkdownRoot_qhsrt_2._AdaptiveStreaming_qhsrt_2 ._FadeListDecoration_qhsrt_2::marker{--duration:var(--animation-duration-streaming-text)}._MarkdownRoot_qhsrt_2[data-markdown-animated] ._ImageEnter_qhsrt_2{transform-origin:50%;animation:.18s ease-out both _image-enter_qhsrt_2}";
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /_AdaptiveStreaming_qhsrt_2 ._FadeIn_qhsrt_2/u);
  assert.equal(applyLinuxMarkdownAnimationPerformancePatch(patched), patched);
});
