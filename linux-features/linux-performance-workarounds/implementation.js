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
  "WARN: Could not uniquely identify the current app-shell tab layout contract — skipping Linux tab layout performance patch";
const MARKDOWN_WARNING =
  "WARN: Could not uniquely identify the streaming Markdown animation contract — skipping Linux Markdown animation performance patch";
const TAB_OVERFLOW_HELPER =
  "const codexLinuxAppShellTabOverflowFrames=new WeakMap;function codexLinuxScheduleAppShellTabOverflow(e,t){if(e?.isConnected&&!codexLinuxAppShellTabOverflowFrames.has(e)){let n=requestAnimationFrame(()=>{codexLinuxAppShellTabOverflowFrames.delete(e),e.isConnected&&t(e.scrollWidth>e.clientWidth)});codexLinuxAppShellTabOverflowFrames.set(e,n)}}";

function markdownRules(source) {
  const unpatched =
    /(\._MarkdownRoot_([A-Za-z0-9]+)_\d+\[data-markdown-animated\] :is\(\._FadeIn_\2_\d+,\._HorizontalRule_\2_\d+,\._ListItem_\2_\d+,\._TableRow_\2_\d+,\._Blockquote_\2_\d+\))\{opacity:0;animation:_fade-in_\2_\d+ ([^{}]+);animation-delay:var\(--fade-delay,0s\)\}(\._MarkdownRoot_\2_\d+\[data-markdown-animated\] \._FadeListDecoration_\2_\d+::marker)\{animation:_fade-in-marker_\2_\d+ \3;animation-delay:var\(--fade-delay,0s\)\}/gu;
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

function enclosingFunction(source, targetIndex) {
  const pattern = /function ([A-Za-z_$][\w$]*)\([^)]*\)\{/gu;
  let enclosing = null;
  for (const candidate of source.matchAll(pattern)) {
    if (candidate.index > targetIndex) break;
    const open = candidate.index + candidate[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close >= targetIndex) enclosing = { start: candidate.index, end: close + 1 };
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
  const controllerPattern = /animate:([A-Za-z_$][\w$]*),"data-app-shell-tab-controller":[A-Za-z_$][\w$]*,[\s\S]{0,300}?initial:([A-Za-z_$][\w$]*),[\s\S]{0,300}?transition:[A-Za-z_$][\w$]*,onAnimationComplete:/gu;
  const candidates = [];
  for (const controller of source.matchAll(controllerPattern)) {
    const owner = enclosingFunction(source, controller.index);
    if (owner == null) continue;
    const ownerSource = source.slice(owner.start, owner.end);
    const initialVar = controller[2];
    if (!ownerSource.includes("@container/app-shell-tab")) continue;
    const assignmentPattern = new RegExp(
      `(?:let |,)${escapeRegExp(initialVar)}=(?<expression>!1|(?<animate>[A-Za-z_$][\\w$]*)\\?(?<collapsed>[A-Za-z_$][\\w$]*):!1),`,
      "u",
    );
    const assignment = assignmentPattern.exec(ownerSource);
    if (assignment == null) continue;
    const patched = assignment.groups.expression === "!1";
    if (patched) {
      if (!/animateLayout:[A-Za-z_$][\w$]*(?:[,}])/u.test(ownerSource)) continue;
    } else {
      if (!new RegExp(`animateLayout:${escapeRegExp(assignment.groups.animate)}(?:[,}])`, "u").test(ownerSource)) continue;
      const collapsedVar = assignment.groups.collapsed;
      const collapsedSelection = ownerSource.match(
        new RegExp(`(?:let |,)${escapeRegExp(collapsedVar)}=[A-Za-z_$][\\w$]*\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*),`, "u"),
      );
      if (collapsedSelection == null || !collapsedSelection.slice(1).every((name) =>
        new RegExp("(?:var |,)" + escapeRegExp(name) + "=\\{maxWidth:`0px`", "u").test(source)
      )) continue;
    }
    const relativeExpressionStart = assignment.index + assignment[0].indexOf(assignment.groups.expression);
    candidates.push({
      expressionStart: owner.start + relativeExpressionStart,
      expressionEnd: owner.start + relativeExpressionStart + assignment.groups.expression.length,
      patched,
    });
  }
  return candidates;
}

function matchesLinuxAppShellTabLayoutPerformanceContract(source) {
  const mounts = mountAnimations(source);
  const measurements = overflowMeasurements(source);
  if (mounts.length !== 1 || measurements.length < 1) return false;
  const patched = mounts[0].patched && measurements.every(({ patched: value }) => value);
  const pristine = !mounts[0].patched && measurements.every(({ patched: value }) => !value);
  const helper = source.includes(TAB_OVERFLOW_HELPER);
  return (patched && helper) || (pristine && !helper);
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
      ].sort((left, right) => right.start - left.start);
      let result = source;
      for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      return result;
    }
  }
  if (source.includes("data-app-shell-tab-controller") && source.includes("@container/app-shell-tab")) {
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
