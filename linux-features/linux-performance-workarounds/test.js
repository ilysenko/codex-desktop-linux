"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyLinuxMarkdownAnimationPerformancePatch,
  matchesLinuxMarkdownAnimationPerformanceContract,
} = require("./implementation.js");

test("linux-performance-workarounds remains an opt-in renderer-only feature", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id, phase }) => [id, phase]),
    [
      ["sidebar-scroll", "webview-asset"],
      ["markdown-animation", "webview-asset"],
    ],
  );
  assert.equal(descriptors[0].pattern.test("app-primary-a0bff570446b.js"), false);
  assert.equal(descriptors[0].pattern.test("app-initial-cccb87527a41.js"), true);
  assert.equal(descriptors[1].pattern.test("app-primary-a0bff570446b.css"), true);
  assert.equal(descriptors[1].pattern.test("app-initial-cccb87527a41.css"), false);
});

test("current Markdown animation workaround disables streaming fades", () => {
  const source = "._MarkdownRoot_wt3tt_184[data-markdown-animated] :is(._FadeIn_wt3tt_659,._HorizontalRule_wt3tt_327,._ListItem_wt3tt_124,._TableRow_wt3tt_543,._Blockquote_wt3tt_285){opacity:0;animation:_fade-in_wt3tt_1 var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_wt3tt_184[data-markdown-animated] ._FadeListDecoration_wt3tt_666::marker{animation:_fade-in-marker_wt3tt_1 var(--duration,var(--transition-duration-basic)) var(--fade-easing,cubic-bezier(.37, .55, .86, .88)) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_wt3tt_184[data-markdown-animated] ._ImageEnter_wt3tt_672{transform-origin:50%;animation:.18s ease-out both _image-enter_wt3tt_1}";

  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(source), true);
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /FadeIn_wt3tt_659[^{}]*\{opacity:1;animation:none\}/u);
  assert.match(patched, /FadeListDecoration_wt3tt_666::marker\{animation:none\}/u);
  assert.equal(matchesLinuxMarkdownAnimationPerformanceContract(patched), true);
  assert.equal(applyLinuxMarkdownAnimationPerformancePatch(patched), patched);
});

test("current adaptive-streaming rules are preserved between the patched fade rules", () => {
  const source = "._MarkdownRoot_qhsrt_2[data-markdown-animated] :is(._FadeIn_qhsrt_2,._HorizontalRule_qhsrt_2,._ListItem_qhsrt_2,._TableRow_qhsrt_2,._Blockquote_qhsrt_2){opacity:0;animation:_fade-in_qhsrt_2 var(--duration) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_qhsrt_2[data-markdown-animated] ._FadeListDecoration_qhsrt_2::marker{animation:_fade-in-marker_qhsrt_2 var(--duration) forwards;animation-delay:var(--fade-delay,0s)}._MarkdownRoot_qhsrt_2._AdaptiveStreaming_qhsrt_2 ._FadeIn_qhsrt_2{--duration:var(--animation-duration-streaming-text)}._MarkdownRoot_qhsrt_2._AdaptiveStreaming_qhsrt_2 ._FadeListDecoration_qhsrt_2::marker{--duration:var(--animation-duration-streaming-text)}._MarkdownRoot_qhsrt_2[data-markdown-animated] ._ImageEnter_qhsrt_2{transform-origin:50%;animation:.18s ease-out both _image-enter_qhsrt_2}";
  const patched = applyLinuxMarkdownAnimationPerformancePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /_AdaptiveStreaming_qhsrt_2 ._FadeIn_qhsrt_2/u);
  assert.equal(applyLinuxMarkdownAnimationPerformancePatch(patched), patched);
});
