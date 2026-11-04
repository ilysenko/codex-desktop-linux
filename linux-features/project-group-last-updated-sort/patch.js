"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const order = String.raw`(?:\(0,${identifier}\.${identifier}\)|${identifier})`;
const groupsArgument = String.raw`groups:${identifier}\(\{groups:${identifier},items:(?<items>${identifier})\}\)`;
const projectOrderArgument = String.raw`projectOrder:${order}\(${identifier},${identifier}\.${identifier}\.PROJECT_ORDER\)`;
// Upstream compiles the unpinned project-group sorter inline:
// `groups=function({groups:e,projectOrder:t}){return order(e,t)}({groups:filter({…,items}),projectOrder:read(get,keys.PROJECT_ORDER)})`.
const currentGroupSorterPattern = new RegExp(
  String.raw`(?<![\w$])${identifier}=function\(\{groups:(?<groups>${identifier}),projectOrder:(?<projectOrder>${identifier})\}\)\{return ?(?<order>${order})\(\k<groups>,\k<projectOrder>\)\}` +
    String.raw`\(\{${groupsArgument},${projectOrderArgument}\}\)`,
  "g",
);
const patchedGroupSorterPattern = new RegExp(
  String.raw`(?<![\w$])${identifier}=function\(\{groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode\}\)\{if\(codexLinuxProjectSortMode!=="updated_at"\)return ?(?<order>${order})\(e,n\);` +
    String.raw`(?:(?!\}\(\{groups:)[^]){0,400}\}\(\{${groupsArgument},${projectOrderArgument},getRecencyAt:(?<recency>${identifier}),sortMode:(?<mode>${identifier})\}\)`,
  "g",
);
const projectlessSorterStart = new RegExp(
  String.raw`^,${identifier}=function\(\{explicitChatThreadKeys:${identifier},getRecencyAt:${identifier},items:${identifier},projectGroups:${identifier},projectlessThreadIds:${identifier}\}\)\{`,
);
const MODE_LOOKBEHIND = 3000;

function allMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))];
}

// Bind the unpinned group sorter to the adjacent projectless sorter that
// receives the same normalized sidebar items. Recency comes from upstream's
// key resolver passed to that sorter, and the mode from the sidebar settings.
function callContext(source, match) {
  const prefix = source.slice(Math.max(0, match.index - MODE_LOOKBEHIND), match.index);
  const modes = [...prefix.matchAll(new RegExp(
    String.raw`\{chatSortMode:${identifier},projectSortMode:(${identifier})\}=${identifier}\(${identifier}(?:\.${identifier})?\)`, "g",
  ))];
  const tailStart = match.index + match[0].length;
  const start = source.slice(tailStart, tailStart + 400).match(projectlessSorterStart);
  if (modes.length !== 1 || start == null) return null;
  const close = findMatchingBrace(source, tailStart + start[0].length - 1);
  if (close < 0) return null;
  const resolver = source.slice(close + 1, close + 400).match(new RegExp(
    String.raw`^\(\{explicitChatThreadKeys:${identifier},getRecencyAt:(${identifier}),items:${escapeRegExp(match.groups.items)},projectGroups:${identifier},projectlessThreadIds:new Set\(${identifier}\?\?\[\]\)\}\)`,
  ));
  return resolver ? { mode: modes[0][1], recency: resolver[1] } : null;
}

function patchedGroupSorter(orderFunction) {
  return `function({groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode}){if(codexLinuxProjectSortMode!=="updated_at")return ${orderFunction}(e,n);return e.map((e,n)=>({group:e,index:n,recencyAt:e.threadKeys.reduce((e,n)=>Math.max(e,t(n)??0),e.projectUpdatedAt??0)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e)}`;
}

function contract(source) {
  const current = allMatches(source, currentGroupSorterPattern);
  const patched = allMatches(source, patchedGroupSorterPattern);
  if (current.length + patched.length !== 1) return null;
  const isPatched = patched.length === 1;
  const match = (isPatched ? patched : current)[0];
  const orderFunction = match.groups.order;
  // The replacement sorter declares e, t and n; the order function must not
  // resolve through one of those parameter names.
  if (/^(?:\(0,)?[etn](?:\.|$)/.test(orderFunction)) return null;
  const context = callContext(source, match);
  if (!context) return null;
  if (isPatched) {
    if (match.groups.recency !== context.recency || match.groups.mode !== context.mode) return null;
    if (!match[0].includes(`=${patchedGroupSorter(orderFunction)}({`)) return null;
  } else if (
    [context.recency, context.mode].some((name) => ["e", "t", "n"].includes(name))
  ) {
    return null;
  }
  return { isPatched, match, context, orderFunction };
}

function applyProjectGroupLastUpdatedSortPatch(source) {
  const found = contract(source);
  if (!found) {
    console.warn("WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch");
    return source;
  }
  if (found.isPatched) return source;
  const { match, context, orderFunction } = found;
  const sorterEnd = match[0].indexOf("}({") + 1;
  const declaration = match[0].slice(0, match[0].indexOf("=") + 1);
  const call = match[0].slice(sorterEnd);
  const patched = `${declaration}${patchedGroupSorter(orderFunction)}` +
    `${call.slice(0, -2)},getRecencyAt:${context.recency},sortMode:${context.mode}})`;
  return source.slice(0, match.index) + patched + source.slice(match.index + match[0].length);
}

const descriptors = [{
  id: "last-updated-project-groups",
  phase: "webview-asset",
  order: 20_900,
  ciPolicy: "optional",
  assetNeedles: [".PROJECT_ORDER)", "projectSortMode:", "explicitChatThreadKeys:"],
  assetMatch: (source) => contract(source) != null,
  missingDescription: "unique project group sort webview bundle",
  skipDescription: "project group Last updated sorting feature patch",
  apply: applyProjectGroupLastUpdatedSortPatch,
}];

module.exports = { applyProjectGroupLastUpdatedSortPatch, descriptors };
