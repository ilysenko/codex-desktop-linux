"use strict";

const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");
const JS_IDENT = "[A-Za-z_$][\\w$]*";

const SIDEBAR_STYLE =
  "{animationName:`none`,animationTimeline:`auto`,\"--bottom-fade\":`calc(var(--spacing) * 10)`}";
const SIDEBAR_WARNING =
  "WARN: Could not uniquely identify the main sidebar scroll container — skipping Linux sidebar scroll performance patch";
const TAB_WARNING =
  "WARN: Could not uniquely identify the current app-shell tab layout contract — skipping Linux tab layout performance patch";
const MARKDOWN_WARNING =
  "WARN: Could not uniquely identify the streaming Markdown animation contract — skipping Linux Markdown animation performance patch";

function markdownRules(source) {
  const unpatched =
    /(\._MarkdownRoot_([A-Za-z0-9]+)_\d+\[data-markdown-animated\] :is\(\._FadeIn_\2_\d+,\._HorizontalRule_\2_\d+,\._ListItem_\2_\d+,\._TableRow_\2_\d+,\._Blockquote_\2_\d+\))\{opacity:1;animation:_fade-in_\2_\d+ ([^{};]+) both;animation-delay:var\(--fade-delay,0s\)\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._FadeListDecoration_\2_\d+::marker)\{animation:_fade-in-marker_\2_\d+ \3 forwards;animation-delay:var\(--fade-delay,0s\)\}/gu;
  const patched =
    /(\._MarkdownRoot_([A-Za-z0-9]+)_\d+\[data-markdown-animated\] :is\(\._FadeIn_\2_\d+,\._HorizontalRule_\2_\d+,\._ListItem_\2_\d+,\._TableRow_\2_\d+,\._Blockquote_\2_\d+\))\{opacity:1;animation:none\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._FadeListDecoration_\2_\d+::marker)\{animation:none\}/gu;
  const candidates = [];
  for (const match of source.matchAll(unpatched)) {
    const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 1000);
    const image = tail.match(new RegExp(`^([\\s\\S]*?)(\\._MarkdownRoot_${match[2]}_\\d+\\[data-markdown-animated\\] \\._ImageEnter_${match[2]}_\\d+\\{transform-origin:50%;animation:\\.18s ease-out both _image-enter_${match[2]}_\\d+\\})`, "u"));
    if (image == null) continue;
    candidates.push({
      start: match.index,
      end: match.index + match[0].length + image[0].length,
      patched: false,
      replacement: `${match[1]}{opacity:1;animation:none}${match[4]}{animation:none}${image[1]}${image[2]}`,
    });
  }
  for (const match of source.matchAll(patched)) {
    const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 1000);
    const image = tail.match(new RegExp(`^[\\s\\S]*?\\._MarkdownRoot_${match[2]}_\\d+\\[data-markdown-animated\\] \\._ImageEnter_${match[2]}_\\d+\\{transform-origin:50%;animation:\\.18s ease-out both _image-enter_${match[2]}_\\d+\\}`, "u"));
    if (image != null) candidates.push({ start: match.index, end: match.index + match[0].length + image[0].length, patched: true, replacement: match[0] + image[0] });
  }
  return candidates;
}

function matchesLinuxMarkdownAnimationPerformanceContract(source) {
  return markdownRules(source).length === 1;
}

function applyLinuxMarkdownAnimationPerformancePatch(source) {
  const candidates = markdownRules(source);
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return candidate.patched
      ? source
      : source.slice(0, candidate.start) + candidate.replacement + source.slice(candidate.end);
  }
  if (source.includes("data-markdown-animated") && source.includes("_FadeListDecoration_")) {
    console.warn(MARKDOWN_WARNING);
  }
  return source;
}

function layoutAnimationFlags(source) {
  const currentPattern = new RegExp(
    `animateLayout:(?<expression>!(${JS_IDENT})\\.isWorkspaceHome&&(${JS_IDENT})\\.animateLayout),` +
      `animateExit:!\\2\\.isWorkspaceHome&&\\3\\.animateExit,closeButtonTabIndex:-1,` +
      "controller:" + JS_IDENT + ",dragActivator:`tab`,tab:\\2",
    "gu",
  );
  const patchedPattern = new RegExp(
    `animateLayout:(?<expression>!1),animateExit:!(${JS_IDENT})\\.isWorkspaceHome&&(${JS_IDENT})\\.animateExit,` +
      "closeButtonTabIndex:-1,controller:" + JS_IDENT + ",dragActivator:`tab`,tab:\\2",
    "gu",
  );
  return [...source.matchAll(currentPattern), ...source.matchAll(patchedPattern)].map((match) => ({
    start: match.index + match[0].indexOf(match.groups.expression),
    end: match.index + match[0].indexOf(match.groups.expression) + match.groups.expression.length,
    patched: match.groups.expression === "!1",
  }));
}

function matchesLinuxAppShellTabLayoutPerformanceContract(source) {
  const flags = layoutAnimationFlags(source);
  return flags.length === 1;
}

function applyLinuxAppShellTabLayoutPerformancePatch(source) {
  const flags = layoutAnimationFlags(source);
  if (flags.length === 1) {
    const flag = flags[0];
    return flag.patched
      ? source
      : source.slice(0, flag.start) + "!1" + source.slice(flag.end);
  }
  if (source.includes("animateLayout:") && source.includes("dragActivator:`tab`")) {
    console.warn(TAB_WARNING);
  }
  return source;
}

function sidebarContainers(source) {
  const anchors = /\{\.\.\.[A-Za-z_$][\w$]*\.sidebarScroll,className:/gu;
  const containers = [];
  for (const anchor of source.matchAll(anchors)) {
    const tail = source.slice(anchor.index, anchor.index + 4000);
    const props = tail.match(/\)(?:,style:(\{[^{}]*\}))?,ref:[A-Za-z_$][\w$]*,onScroll:[A-Za-z_$][\w$]*=>\{/u);
    if (props?.index == null) continue;
    const className = tail.slice(0, props.index + 1);
    if (!className.includes("vertical-scroll-fade-mask") || !className.includes("[contain:layout_paint]") || !className.includes(".headerFadeMask")) continue;
    const open = anchor.index + props.index + props[0].lastIndexOf("{");
    const close = findMatchingBrace(source, open);
    if (close === -1) continue;
    const handler = source.slice(open, close + 1);
    if (!/let\{scrollTop:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*\.currentTarget/u.test(handler)) continue;
    const style = props[1] ?? null;
    containers.push({ classNameEnd: anchor.index + props.index + 1, style, styleComplete: style == null || style === SIDEBAR_STYLE });
  }
  return containers;
}

function matchesLinuxSidebarScrollPerformanceContract(source) {
  const containers = sidebarContainers(source);
  return containers.length === 1 && containers[0].styleComplete;
}

function applyLinuxSidebarScrollPerformancePatch(source) {
  const containers = sidebarContainers(source);
  if (containers.length === 1 && containers[0].styleComplete) {
    const container = containers[0];
    if (container.style === SIDEBAR_STYLE) return source;
    return source.slice(0, container.classNameEnd) + `,style:${SIDEBAR_STYLE}` + source.slice(container.classNameEnd);
  }
  if (containers.some(({ styleComplete }) => !styleComplete)) {
    console.warn("WARN: Found incomplete Linux sidebar scroll performance patch — skipping");
  } else if (source.includes(".sidebarScroll") && source.includes("vertical-scroll-fade-mask") && source.includes("[contain:layout_paint]")) {
    console.warn(SIDEBAR_WARNING);
  }
  return source;
}

module.exports = {
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationPerformancePatch,
  applyLinuxSidebarScrollPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxMarkdownAnimationPerformanceContract,
  matchesLinuxSidebarScrollPerformanceContract,
};
