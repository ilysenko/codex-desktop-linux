"use strict";

const path = require("node:path");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxProjectGroupsUpdated";
const INLINE_HEAD = new RegExp(
  `function\\(\\{groups:(?<groups>${ID}),(?:getRecencyAt:codexLinuxProjectGetRecencyAt,)?` +
  `projectOrder:(?<order>${ID})(?:,sortMode:codexLinuxProjectSortMode)?\\}\\)\\{`, "g");
const CALLBACK = new RegExp(`\\(${ID},\\{get:(?<get>${ID}),scope:${ID}\\}\\)=>\\{`, "g");
const GROUP_CALL = new RegExp(
  `^\\(\\{groups:(?<filter>${ID})\\(\\{groups:(?<groups>${ID}),items:(?<items>${ID})\\}\\),` +
  `projectOrder:\\(0,${ID}\\.${ID}\\)\\((?<get>${ID}),${ID}\\.${ID}\\.PROJECT_ORDER\\)` +
  `(?:,getRecencyAt:(?<recency>${ID}),sortMode:(?<mode>${ID}))?\\}\\)`);

function allMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))];
}

function sorterSource(groups, order, orderFunction) {
  return `function({groups:${groups},getRecencyAt:codexLinuxProjectGetRecencyAt,projectOrder:${order},sortMode:codexLinuxProjectSortMode}){/*${MARKER}*/if(codexLinuxProjectSortMode!=="updated_at")return${orderFunction}(${groups},${order});return ${groups}.map((group,index)=>({group,index,recencyAt:group.threadKeys.reduce((latest,key)=>{let timestamp=codexLinuxProjectGetRecencyAt(key);return Number.isFinite(timestamp)?Math.max(latest,timestamp):latest},Number.isFinite(group.projectUpdatedAt)?group.projectUpdatedAt:0)})).sort((left,right)=>right.recencyAt-left.recencyAt||left.index-right.index).map(({group})=>group)}`;
}

function containingCallback(source, index, getter) {
  const callbacks = allMatches(source, CALLBACK).map((match) => {
    const start = match.index + match[0].length;
    return { start, end: findMatchingBrace(source, start - 1), getter: match.groups.get };
  }).filter((scope) => scope.getter === getter && scope.start <= index && index < scope.end);
  return callbacks.length === 1 ? callbacks[0] : null;
}

function nestedFunctionContains(source, start, end, index) {
  // A binding in an inner function cannot supply the sidebar callback. The
  // semantic callback and initializer anchors already delimit this small region.
  const nested = new RegExp(`(?:function(?: ${ID})?\\([^)]*\\)|(?:\\([^)]*\\)|${ID})=>)\\{`, "g");
  for (const match of source.slice(start, end).matchAll(nested)) {
    const open = start + match.index + match[0].length - 1;
    if (open < index && index < findMatchingBrace(source, open)) return true;
  }
  return false;
}

function recencyContext(source, scope, beforeCall) {
  const pattern = new RegExp(
    `\\{chatSortMode:${ID},projectSortMode:(?<mode>${ID})\\}=${escapeRegExp(scope.getter)}\\(${ID}\\.${ID}\\),` +
    `(?<cache>${ID})=new Map,(?<recency>${ID})=(?<key>${ID})=>\\{` +
    `let (?<cached>${ID})=\\k<cache>\\.get\\(\\k<key>\\);if\\(null!=\\k<cached>\\)return \\k<cached>;` +
    `let (?<value>${ID})=\\(0,${ID}\\.${ID}\\)\\(${escapeRegExp(scope.getter)},\\k<key>\\);` +
    `return \\k<cache>\\.set\\(\\k<key>,\\k<value>\\),\\k<value>\\}`, "g");
  const matches = allMatches(source.slice(scope.start, beforeCall), pattern);
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (nestedFunctionContains(source, scope.start, beforeCall, scope.start + match.index)) return null;
  return match.groups;
}

function projectlessContext(source, callEnd, scopeEnd, items) {
  const tail = source.slice(callEnd, scopeEnd);
  const header = new RegExp(`^,${ID}=function\\(\\{explicitChatThreadKeys:${ID},getRecencyAt:${ID},items:${ID},projectGroups:${ID},projectlessThreadIds:${ID}\\}\\)\\{`).exec(tail);
  if (header == null) return null;
  const open = callEnd + header[0].length - 1;
  const end = findMatchingBrace(source, open);
  if (end < open || end >= scopeEnd) return null;
  return new RegExp(
    `^\\(\\{explicitChatThreadKeys:${ID},getRecencyAt:(?<recency>${ID}),items:${escapeRegExp(items)},` +
    `projectGroups:(?<groups>${ID}),projectlessThreadIds:new Set\\(${ID}\\?\\?\\[\\]\\)\\}\\)`
  ).exec(source.slice(end + 1, scopeEnd))?.groups ?? null;
}

function projectTaskContext(source, scope, output, recency, mode) {
  const pattern = new RegExp(`${escapeRegExp(output)}=${escapeRegExp(output)}\\.map\\((${ID})=>\\{`, "g");
  const matches = allMatches(source.slice(scope.start, scope.end), pattern);
  if (matches.length !== 1) return false;
  const match = matches[0];
  const open = scope.start + match.index + match[0].length - 1;
  const end = findMatchingBrace(source, open);
  if (end < open || end >= scope.end) return false;
  const body = source.slice(open + 1, end);
  return body.includes(`getRecencyAt:${recency},items:${match[1]}.threadKeys.flatMap(`) &&
    body.includes("manualThreadIds:") && body.includes(`,sortMode:${mode}})`);
}

function contract(source) {
  const heads = allMatches(source, INLINE_HEAD);
  if (heads.length !== 1) return null;
  const head = heads[0];
  const open = head.index + head[0].length - 1;
  const end = findMatchingBrace(source, open);
  if (end < open) return null;
  const body = source.slice(open + 1, end);
  const { groups, order } = head.groups;
  const current = new RegExp(`^return(?<fn>\\(0,${ID}\\.${ID}\\))\\(${escapeRegExp(groups)},${escapeRegExp(order)}\\)$`).exec(body);
  const patched = new RegExp(`^/\\*${MARKER}\\*/if\\(codexLinuxProjectSortMode!=="updated_at"\\)return(?<fn>\\(0,${ID}\\.${ID}\\))\\(${escapeRegExp(groups)},${escapeRegExp(order)}\\);`).exec(body);
  if ((current == null) === (patched == null)) return null;
  const isPatched = patched != null;
  const orderFunction = (current ?? patched).groups.fn;
  const functionSource = source.slice(head.index, end + 1);
  if (isPatched && (functionSource !== sorterSource(groups, order, orderFunction) || source.split(MARKER).length !== 2)) return null;
  if (!isPatched && (source.includes(MARKER) || head[0] !== `function({groups:${groups},projectOrder:${order}}){`)) return null;
  const call = GROUP_CALL.exec(source.slice(end + 1));
  if (call == null || isPatched !== (call.groups.recency != null)) return null;
  const callEnd = end + 1 + call[0].length;
  const scope = containingCallback(source, head.index, call.groups.get);
  if (scope == null) return null;
  const context = recencyContext(source, scope, head.index);
  const projectless = projectlessContext(source, callEnd, scope.end, call.groups.items);
  if (context == null || projectless == null || context.recency !== projectless.recency) return null;
  const pinned = new RegExp(
    `\\{pinnedGroups:(?<pinned>${ID}),unpinnedGroups:${escapeRegExp(call.groups.groups)}\\}=\\(0,${ID}\\.${ID}\\)\\(${escapeRegExp(projectless.groups)},${ID}\\),` +
    `${ID}=${escapeRegExp(call.groups.filter)}\\(\\{groups:\\k<pinned>,items:${escapeRegExp(call.groups.items)}\\}\\),(?<output>${ID})=$`
  ).exec(source.slice(scope.start, head.index));
  if (pinned == null || !projectTaskContext(source, scope, pinned.groups.output, context.recency, context.mode)) return null;
  if (isPatched && (call.groups.recency !== context.recency || call.groups.mode !== context.mode)) return null;
  return { isPatched, start: head.index, end: callEnd, functionSource, call: call[0], groups, order, orderFunction, context };
}

function applyProjectGroupLastUpdatedSortPatch(source) {
  const found = contract(source);
  if (found == null) {
    console.warn("WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch");
    return source;
  }
  if (found.isPatched) return source;
  const call = `${found.call.slice(0, -2)},getRecencyAt:${found.context.recency},sortMode:${found.context.mode}})`;
  const patched = source.slice(0, found.start) + sorterSource(found.groups, found.order, found.orderFunction) + call + source.slice(found.end);
  if (contract(patched)?.isPatched) return patched;
  console.warn("WARN: Project group Last updated sort post-patch verification failed");
  return source;
}

function identifiesOwner(source) {
  return source.includes("projectOrder:") && source.includes("explicitChatThreadKeys") && source.includes("projectSortMode:");
}

function patchProjectGroupAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, {
    matchModule: identifiesOwner, sourceMatch: identifiesOwner,
    description: "project group sorting sidebar",
  });
  return patchRspackModuleCopies(assets, copies, (source) => {
    if (contract(source) == null) throw new Error("Incomplete project group sorting sidebar contract");
    return applyProjectGroupLastUpdatedSortPatch(source);
  });
}

const descriptors = [{
  id: "last-updated-project-groups",
  phase: "extracted-app:pre-webview",
  order: 20_900,
  ciPolicy: "optional",
  apply: patchProjectGroupAssets,
}];

module.exports = { applyProjectGroupLastUpdatedSortPatch, descriptors };
