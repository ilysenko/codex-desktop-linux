"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const JS_IDENT = "[A-Za-z_$][\\w$]*";
// rspack references imported bindings as member chains such as `x.It`.
const JS_MEMBER = `${JS_IDENT}(?:\\.${JS_IDENT})*`;
// rspack CSS modules emit `.Name-hash` class names and `name-hash` keyframes.
const CSS_HASH = "[A-Za-z0-9_-]+";

const SIDEBAR_STYLE =
  '{animationName:"none",animationTimeline:"auto","--bottom-fade":"calc(var(--spacing) * 10)"}';

const SIDEBAR_ASSET_NEEDLES = [".sidebarScroll,className:", "vertical-scroll-fade-mask", "[contain:layout_paint]"];
const TAB_ASSET_NEEDLES = ["animateLayout:", "data-app-shell-tab-separator", "data-app-shell-tab-strip-controller"];
const MARKDOWN_STYLESHEET_NEEDLES = ["[data-markdown-animated]", ".FadeListDecoration-", ".ImageEnter-"];
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
      rootHash: match[2],
      replacement: `${match[1]}{opacity:1;animation:none}${match[4]}{animation:none}${image[1]}${image[2]}`,
    });
  }
  for (const match of source.matchAll(patched)) {
    const tail = source.slice(match.index + match[0].length, match.index + match[0].length + 1000);
    const image = tail.match(new RegExp(`^[\\s\\S]*?${imageRule(match[2])}`, "u"));
    if (image != null) candidates.push({ start: match.index, end: match.index + match[0].length + image[0].length, patched: true, rootHash: match[2], replacement: match[0] + image[0] });
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

// rspack duplicates this CSS module across chunk groups. Validate the entire
// copy set before committing any writes, including recursively nested assets.
function applyLinuxMarkdownAnimationStylesheetPatch(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const owners = listWebviewAssetFiles(assetsDir, /\.css$/u)
    .map((assetName) => ({ assetName, source: fs.readFileSync(path.join(assetsDir, assetName), "utf8") }))
    // A damaged copy can lose one anchor; a root-only override is unrelated.
    .filter(({ source }) => MARKDOWN_STYLESHEET_NEEDLES.filter((needle) => source.includes(needle)).length >= 2)
    .map((owner) => ({ ...owner, rules: markdownRules(owner.source) }));
  const drifted = owners.filter(({ rules }) => rules.length !== 1);
  const states = new Set(owners.flatMap(({ rules }) => rules.map(({ rootHash, patched }) => `${rootHash}:${patched}`)));
  if (owners.length === 0 || drifted.length > 0 || states.size !== 1) {
    console.warn(
      `WARN: Could not identify one complete streaming Markdown stylesheet state in ${assetsDir} ` +
        `(${owners.length} found, ${drifted.length} drifted, ${states.size} identities/states) — skipping Markdown animation performance workaround`,
    );
    return { changed: false, assetNames: [] };
  }
  const result = commitAssetEdits(assetsDir, owners.map(({ assetName, source }) => ({
    assetName, source, patchedSource: applyLinuxMarkdownAnimationPerformancePatch(source),
  })));
  return { changed: result.changed > 0, assetNames: result.changedAssets };
}

function layoutAnimationFlags(source) {
  const renderPattern = new RegExp(
    `(?<collection>${JS_IDENT})\\.map\\(\\((?<tab>${JS_IDENT}),(?<index>${JS_IDENT})\\)=>\\{` +
      `let (?<active>${JS_IDENT})=(?<selected>${JS_IDENT})===\\k<tab>\\.id,` +
      `(?<next>${JS_IDENT})=\\k<collection>\\[\\k<index>\\+1\\],` +
      `(?<separator>${JS_IDENT})=\\k<index><\\k<collection>\\.length-1&&!\\k<active>&&\\k<selected>!==\\k<next>\\?\\.id,` +
      `(?<element>${JS_IDENT})=\\k<tab>\\.render\\(\\{disabled:\\k<tab>\\.disabled,isActive:\\k<active>,isClosable:\\k<tab>\\.isClosable,` +
      `isPresented:${JS_IDENT}===\\k<tab>\\.id,isRenaming:${JS_IDENT}===\\k<tab>\\.id,` +
      `animateLayout:(?<expression>${JS_IDENT}|!1),animateExit:(?<motion>${JS_IDENT})&&!(?<position>${JS_IDENT}),` +
      `animatePosition:\\k<motion>&&\\k<position>,animateWidth:${JS_IDENT},layoutTransition:${JS_IDENT},` +
      `targetWidth:${JS_IDENT}\\[\\k<index>\\],onActionsWidthChange:`,
    "gu",
  );
  let modules;
  try {
    modules = source.includes("__webpack_modules__")
      ? [...rspackModuleFactories(source, "app-shell tabs")]
      : [{ moduleSource: source, start: 0 }];
  } catch { return []; }
  const flags = [];
  for (const module of modules) {
    const body = module.moduleSource;
    const inCode = match => findMatchingBrace("{" + body.slice(0, match.index) + "}".repeat(match.index + 2), 0) >= match.index + 1;
    const candidates = [...body.matchAll(new RegExp(`(${JS_IDENT})\\.render\\(\\{disabled:\\1\\.disabled,isActive:`, "gu"))].filter(inCode);
    if (candidates.length === 0) continue;
    if (!TAB_ASSET_NEEDLES.every(needle => body.includes(needle))) return [];
    const matches = [...body.matchAll(renderPattern)].filter(inCode);
    if (matches.length !== candidates.length) return [];
    for (const match of matches) {
      const { tab, index, element, expression } = match.groups;
      const entry = escapeRegExp(tab), position = escapeRegExp(index);
      const open = match.index + match[0].indexOf(".render({") + ".render(".length;
      const close = findMatchingBrace(body, open);
      if (close < open) return [];
      const props = body.slice(open + 1, close);
      const separator = new RegExp(`"data-app-shell-tab-separator":${entry}\\.id,"data-app-shell-tab-separator-index":${position}(?=,|\\})`, "u");
      const buttons = new RegExp(`tabButtonProps:\\{"aria-controls":\\(0,${JS_IDENT}\\.${JS_IDENT}\\)\\(${entry}\\.key\\),` +
        `"aria-keyshortcuts":${entry}\\.isClosable\\?"Delete":void 0,id:\\(0,${JS_IDENT}\\.${JS_IDENT}\\)\\(${entry}\\.key\\),` +
        `tabIndex:${JS_IDENT}===${entry}\\?0:-1\\}`, "u");
      const returned = new RegExp(`^\\);return null==${escapeRegExp(element)}\\?null:\\(0,${JS_IDENT}\\.cloneElement\\)\\(${escapeRegExp(element)},\\{key:${entry}\\.key\\}\\)\\}\\)`, "u");
      if (!separator.test(props) || !buttons.test(props) || !returned.test(body.slice(close + 1)) ||
          !new RegExp(`onActionsWidthChange:${JS_IDENT}=>\\{`, "u").test(props) ||
          !new RegExp(`onRenamingChange:${JS_IDENT}=>\\{`, "u").test(props)) return [];
      const start = module.start + match.index + match[0].indexOf("animateLayout:") + "animateLayout:".length;
      flags.push({ start, end: start + expression.length, patched: expression === "!1" });
    }
  }
  return flags;
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
