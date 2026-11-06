"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");
const JS_IDENT = "[A-Za-z_$][\\w$]*";
// rspack references imported bindings as member chains such as `x.It`.
const JS_MEMBER = `${JS_IDENT}(?:\\.${JS_IDENT})*`;
// rspack CSS modules emit `.Name-hash` class names and `name-hash` keyframes.
const CSS_HASH = "[A-Za-z0-9_-]+";

const SIDEBAR_STYLE =
  '{animationName:"none",animationTimeline:"auto","--bottom-fade":"calc(var(--spacing) * 10)"}';

const SIDEBAR_ASSET_NEEDLES = [".sidebarScroll,className:", "vertical-scroll-fade-mask", "[contain:layout_paint]"];
const TAB_ASSET_NEEDLES = [".render({disabled:", "animateLayout:", "animatePosition:"];
const MARKDOWN_STYLESHEET_NEEDLES = ["[data-markdown-animated]", ".FadeListDecoration-", ".ImageEnter-"];
const WEBVIEW_STYLESHEET_DIRECTORIES = ["", "async"];
const SIDEBAR_WARNING =
  "WARN: Could not uniquely identify the main sidebar scroll container — skipping Linux sidebar scroll performance patch";
const TAB_WARNING =
  "WARN: Could not uniquely identify the current app-shell tab layout contract — skipping Linux tab layout performance patch";
const MARKDOWN_WARNING =
  "WARN: Could not uniquely identify the streaming Markdown animation contract — skipping Linux Markdown animation performance patch";

function markdownRules(source) {
  const root = (group) => `\\.MarkdownRoot-${group}\\[data-markdown-animated\\]`;
  const fadeTargets =
    `:is\\(\\.FadeIn-${CSS_HASH},\\.HorizontalRule-${CSS_HASH},\\.ListItem-${CSS_HASH},\\.TableRow-${CSS_HASH},\\.Blockquote-${CSS_HASH}\\)`;
  const unpatched = new RegExp(
    `(${root(`(${CSS_HASH})`)} ${fadeTargets})\\{opacity:1;animation:fade-in-${CSS_HASH} ([^{};]+) both;animation-delay:var\\(--fade-delay,0s\\)\\}` +
      `(${root("\\2")} \\.FadeListDecoration-${CSS_HASH}::marker)\\{animation:fade-in-marker-${CSS_HASH} \\3 forwards;animation-delay:var\\(--fade-delay,0s\\)\\}`,
    "gu",
  );
  const patched = new RegExp(
    `(${root(`(${CSS_HASH})`)} ${fadeTargets})\\{opacity:1;animation:none\\}` +
      `(${root("\\2")} \\.FadeListDecoration-${CSS_HASH}::marker)\\{animation:none\\}`,
    "gu",
  );
  const imageRule = (rootHash) =>
    `${root(rootHash)} \\.ImageEnter-${CSS_HASH}\\{transform-origin:50%;animation:\\.18s ease-out both image-enter-${CSS_HASH}\\}`;
  const candidates = [];
  for (const match of source.matchAll(unpatched)) {
    const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 1000);
    const image = tail.match(new RegExp(`^([\\s\\S]*?)(${imageRule(match[2])})`, "u"));
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
    const image = tail.match(new RegExp(`^[\\s\\S]*?${imageRule(match[2])}`, "u"));
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
  if (MARKDOWN_STYLESHEET_NEEDLES.every((needle) => source.includes(needle))) {
    console.warn(MARKDOWN_WARNING);
  }
  return source;
}

function listWebviewStylesheets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const names = [];
  for (const directory of WEBVIEW_STYLESHEET_DIRECTORIES) {
    const dir = path.join(assetsDir, directory);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".css")) {
        names.push(directory === "" ? entry.name : `${directory}/${entry.name}`);
      }
    }
  }
  return names.sort();
}

// rspack duplicates a CSS module into every async stylesheet of the chunk
// groups that use it, so the Markdown rules occur once in each of several
// CSS files. The webview-asset phase indexes scripts only; this workaround
// discovers the stylesheets itself and patches all of them or none.
function applyLinuxMarkdownAnimationStylesheetPatch(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const owners = listWebviewStylesheets(extractedDir)
    .map((assetName) => ({ assetName, source: fs.readFileSync(path.join(assetsDir, assetName), "utf8") }))
    .filter(({ source }) => MARKDOWN_STYLESHEET_NEEDLES.every((needle) => source.includes(needle)));
  const drifted = owners.filter(({ source }) => !matchesLinuxMarkdownAnimationPerformanceContract(source));
  if (owners.length === 0 || drifted.length > 0) {
    console.warn(
      `WARN: Could not identify the streaming Markdown animation stylesheets in ${assetsDir} ` +
        `(${owners.length} found, ${drifted.length} drifted${drifted.length ? `: ${drifted.map(({ assetName }) => assetName).join(", ")}` : ""}) — skipping Markdown animation performance workaround`,
    );
    return { changed: false, assetNames: [] };
  }
  const writes = owners
    .map(({ assetName, source }) => ({ assetName, source, patched: applyLinuxMarkdownAnimationPerformancePatch(source) }))
    .filter(({ source, patched }) => patched !== source);
  for (const { assetName, patched } of writes) {
    fs.writeFileSync(path.join(assetsDir, assetName), patched, "utf8");
  }
  return { changed: writes.length > 0, assetNames: writes.map(({ assetName }) => assetName) };
}

function layoutAnimationFlags(source) {
  const currentPattern = new RegExp(
    `(?<tab>${JS_IDENT})\\.render\\(\\{disabled:\\k<tab>\\.disabled,isActive:${JS_IDENT},` +
      `isClosable:\\k<tab>\\.isClosable,isPresented:[^,]+,isRenaming:[^,]+,` +
      `animateLayout:(?<expression>${JS_IDENT}),animateExit:[^,]+,animatePosition:[^,]+,animateWidth:`,
    "gu",
  );
  const patchedPattern = new RegExp(
    `(?<tab>${JS_IDENT})\\.render\\(\\{disabled:\\k<tab>\\.disabled,isActive:${JS_IDENT},` +
      `isClosable:\\k<tab>\\.isClosable,isPresented:[^,]+,isRenaming:[^,]+,` +
      `animateLayout:(?<expression>!1),animateExit:[^,]+,animatePosition:[^,]+,animateWidth:`,
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
  if (TAB_ASSET_NEEDLES.every((needle) => source.includes(needle))) {
    console.warn(TAB_WARNING);
  }
  return source;
}

function sidebarContainers(source) {
  const anchors = new RegExp(`\\{\\.\\.\\.${JS_MEMBER}\\.sidebarScroll,className:`, "gu");
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
  } else if (SIDEBAR_ASSET_NEEDLES.every((needle) => source.includes(needle))) {
    console.warn(SIDEBAR_WARNING);
  }
  return source;
}

module.exports = {
  MARKDOWN_STYLESHEET_NEEDLES,
  SIDEBAR_ASSET_NEEDLES,
  TAB_ASSET_NEEDLES,
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationPerformancePatch,
  applyLinuxMarkdownAnimationStylesheetPatch,
  applyLinuxSidebarScrollPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxMarkdownAnimationPerformanceContract,
  matchesLinuxSidebarScrollPerformanceContract,
};
