"use strict";

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const SIDEBAR_STYLE =
  "{animationName:`none`,animationTimeline:`auto`,\"--bottom-fade\":`calc(var(--spacing) * 10)`}";
const SIDEBAR_WARNING =
  "WARN: Could not uniquely identify the main sidebar scroll container — skipping Linux sidebar scroll performance patch";
const TAB_WARNING =
  "WARN: Could not uniquely identify the app-shell tab layout contract — skipping Linux tab layout performance patch";
const MARKDOWN_WARNING =
  "WARN: Could not uniquely identify the streaming Markdown animation contract — skipping Linux Markdown animation performance patch";
const TAB_OVERFLOW_HELPER =
  "const codexLinuxAppShellTabOverflowFrames=new WeakMap;function codexLinuxScheduleAppShellTabOverflow(e,t){if(e?.isConnected&&!codexLinuxAppShellTabOverflowFrames.has(e)){let n=requestAnimationFrame(()=>{codexLinuxAppShellTabOverflowFrames.delete(e),e.isConnected&&t(e.scrollWidth>e.clientWidth)});codexLinuxAppShellTabOverflowFrames.set(e,n)}}";

function markdownRules(source) {
  const unpatched =
    /(\._MarkdownRoot_([A-Za-z0-9]+)_\d+\[data-markdown-animated\] :is\(\._FadeIn_\2_\d+,hr,li,tr,blockquote\))\{opacity:0;animation:_fade-in_\2_1 ([^{}]+);animation-delay:var\(--fade-delay,0s\)\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._FadeListDecoration_\2_\d+::marker)\{animation:_fade-in-marker_\2_1 \3;animation-delay:var\(--fade-delay,0s\)\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._ImageEnter_\2_\d+\{transform-origin:50%;animation:\.18s ease-out both _image-enter_\2_1\})/gu;
  const patched =
    /(\._MarkdownRoot_([A-Za-z0-9]+)_\d+\[data-markdown-animated\] :is\(\._FadeIn_\2_\d+,hr,li,tr,blockquote\))\{opacity:1;animation:none\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._FadeListDecoration_\2_\d+::marker)\{animation:none\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._ImageEnter_\2_\d+\{transform-origin:50%;animation:\.18s ease-out both _image-enter_\2_1\})/gu;
  const candidates = [];
  for (const match of source.matchAll(unpatched)) {
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      patched: false,
      replacement: `${match[1]}{opacity:1;animation:none}${match[4]}{animation:none}${match[5]}`,
    });
  }
  for (const match of source.matchAll(patched)) {
    candidates.push({ start: match.index, end: match.index + match[0].length, patched: true, replacement: match[0] });
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

function enclosingFunction(source, targetIndex) {
  const pattern = /function ([A-Za-z_$][\w$]*)\([^)]*\)\{/gu;
  let enclosing = null;
  for (const candidate of source.matchAll(pattern)) {
    if (candidate.index > targetIndex) break;
    const open = candidate.index + candidate[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close >= targetIndex) enclosing = { start: candidate.index, end: close + 1, name: candidate[1] };
  }
  return enclosing;
}

function overflowMeasurements(source) {
  const pattern = /([A-Za-z_$][\w$]*)=\(e,t\)=>\{(?:([A-Za-z_$][\w$]*)\(t\.scrollWidth>t\.clientWidth\)|codexLinuxScheduleAppShellTabOverflow\(t,([A-Za-z_$][\w$]*)\))\}/gu;
  const candidates = [];
  for (const callback of source.matchAll(pattern)) {
    const owner = enclosingFunction(source, callback.index);
    if (owner == null) continue;
    const ownerSource = source.slice(owner.start, owner.end);
    if (!ownerSource.includes("data-app-shell-tab-close-button") || !ownerSource.includes("@max-[4rem]/app-shell-tab")) continue;
    candidates.push({
      callbackStart: callback.index,
      callbackEnd: callback.index + callback[0].length,
      callbackName: callback[1],
      functionStart: owner.start,
      patched: callback[3] != null,
      setterName: callback[2] ?? callback[3],
    });
  }
  return candidates;
}

function mountAnimations(source) {
  const pattern = /animate:([A-Za-z_$][\w$]*),"data-app-shell-tab-controller":[A-Za-z_$][\w$]*,[\s\S]{0,300}?exit:([A-Za-z_$][\w$]*),[\s\S]{0,100}?initial:([A-Za-z_$][\w$]*),[\s\S]{0,200}?transition:[A-Za-z_$][\w$]*,onAnimationComplete:/gu;
  const candidates = [];
  for (const controller of source.matchAll(pattern)) {
    const animate = controller[1];
    const exit = controller[2];
    const initial = controller[3];
    const prefixStart = Math.max(0, controller.index - 8000);
    const prefix = source.slice(prefixStart, controller.index);
    const vicinity = prefix + source.slice(controller.index, controller.index + 6000);
    const initialPrefix = `,${initial}=`;
    const exitPrefix = `,${exit}=`;
    const unpatched = new RegExp(`${escapeRegExp(exitPrefix)}([A-Za-z_$][\\w$]*)\\?([A-Za-z_$][\\w$]*):void 0,[\\s\\S]{0,100}?${escapeRegExp(initialPrefix)}(\\1&&![A-Za-z_$][\\w$]*\\?\\2:!1),`, "gu");
    const patched = new RegExp(`${escapeRegExp(exitPrefix)}([A-Za-z_$][\\w$]*)\\?([A-Za-z_$][\\w$]*):void 0,[\\s\\S]{0,100}?${escapeRegExp(initialPrefix)}!1,`, "gu");
    const unpatchedMatches = [...prefix.matchAll(unpatched)];
    const patchedMatches = [...prefix.matchAll(patched)];
    const pair = unpatchedMatches.at(-1) ?? patchedMatches.at(-1);
    if (pair == null) continue;
    const isPatched = patchedMatches.at(-1) === pair;
    const selectedAnimation = vicinity.match(
      new RegExp(`${escapeRegExp(pair[2])}=[A-Za-z_$][\\w$]*\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*)`, "u"),
    );
    const selectedCollapsedAnimation = selectedAnimation != null &&
      selectedAnimation.slice(1).every((name) =>
        source.includes(`${name}={maxWidth:\`0px\``));
    if (
      !vicinity.includes("@container/app-shell-tab") ||
      !selectedCollapsedAnimation ||
      !vicinity.includes(`${animate}=`)
    ) continue;
    const declarationStart = prefixStart + pair.index;
    const relativeInitialStart = pair[0].indexOf(initialPrefix) + initialPrefix.length;
    const expressionStart = declarationStart + relativeInitialStart;
    const expression = isPatched ? "!1" : pair[3];
    candidates.push({ expressionStart, expressionEnd: expressionStart + expression.length, patched: isPatched });
  }
  return candidates;
}

function matchesLinuxAppShellTabLayoutPerformanceContract(source) {
  const mounts = mountAnimations(source);
  const measurements = overflowMeasurements(source);
  if (mounts.length !== 1 || measurements.length < 1) return false;
  const patched = mounts[0].patched && measurements.every(({ patched }) => patched);
  const unpatched = !mounts[0].patched && measurements.every(({ patched }) => !patched);
  const helper = source.includes(TAB_OVERFLOW_HELPER);
  return (patched && helper) || (unpatched && !helper);
}

function applyLinuxAppShellTabLayoutPerformancePatch(source) {
  const mounts = mountAnimations(source);
  const measurements = overflowMeasurements(source);
  const helper = source.includes(TAB_OVERFLOW_HELPER);
  if (mounts.length === 1 && measurements.length >= 1) {
    const mount = mounts[0];
    if (mount.patched && measurements.every(({ patched }) => patched) && helper) return source;
    if (!mount.patched && measurements.every(({ patched }) => !patched) && !helper) {
      const edits = [
        { start: mount.expressionStart, end: mount.expressionEnd, text: "!1" },
        ...measurements.map((measurement) => ({
          start: measurement.callbackStart,
          end: measurement.callbackEnd,
          text: `${measurement.callbackName}=(e,t)=>{codexLinuxScheduleAppShellTabOverflow(t,${measurement.setterName})}`,
        })),
        { start: measurements[0].functionStart, end: measurements[0].functionStart, text: TAB_OVERFLOW_HELPER },
      ].sort((a, b) => b.start - a.start);
      let result = source;
      for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      return result;
    }
  }
  if (source.includes("data-app-shell-tab-controller") && source.includes("@container/app-shell-tab")) console.warn(TAB_WARNING);
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
