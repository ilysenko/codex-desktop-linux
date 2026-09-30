"use strict";

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const currentGroupSorterPattern = new RegExp(
  String.raw`function (${identifier})\(\{groups:e,projectOrder:t\}\)\{return (${identifier})\(e,t\)\}`,
  "g",
);
const patchedGroupSorterPattern = new RegExp(
  String.raw`function (${identifier})\(\{groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode\}\)\{if\(codexLinuxProjectSortMode!==\`updated_at\`\)return (${identifier})\(e,n\);`,
  "g",
);

function allMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern.source, pattern.flags))];
}

// Bind the unpinned group filter and adjacent projectless sorter to the same
// normalized sidebar items. Recency now comes from the upstream key resolver.
function sorterCallPattern(sorterName, patched = false) {
  const added = patched ? String.raw`,getRecencyAt:(${identifier}),sortMode:(${identifier})` : "";
  return new RegExp(
    String.raw`${escapeRegExp(sorterName)}\(\{groups:${identifier}\(\{groups:${identifier},items:(${identifier})\}\),projectOrder:${identifier}\(${identifier},${identifier}\.PROJECT_ORDER\)${added}\}\)`,
    "g",
  );
}

function callContext(source, call) {
  const prefix = source.slice(Math.max(0, call.index - 1500), call.index);
  const modes = [...prefix.matchAll(new RegExp(String.raw`\{chatSortMode:${identifier},projectSortMode:(${identifier})\}=${identifier}\(${identifier}\)`, "g"))];
  const tail = source.slice(call.index + call[0].length);
  const resolver = tail.match(new RegExp(
    String.raw`^,${identifier}=${identifier}\(\{explicitChatThreadKeys:${identifier},getRecencyAt:(${identifier}),items:${escapeRegExp(call[1])},projectGroups:${identifier},projectlessThreadIds:new Set\(${identifier}\?\?\[\]\)\}\)`,
  ));
  return modes.length === 1 && resolver ? { mode: modes[0][1], recency: resolver[1] } : null;
}

function patchedGroupSorter(sorterName, orderFunction) {
  return `function ${sorterName}({groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode}){if(codexLinuxProjectSortMode!==\`updated_at\`)return ${orderFunction}(e,n);return e.map((e,n)=>({group:e,index:n,recencyAt:e.threadKeys.reduce((e,n)=>Math.max(e,t(n)??0),e.projectUpdatedAt??0)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e)}`;
}

function contract(source) {
  const current = allMatches(source, currentGroupSorterPattern);
  const patched = allMatches(source, patchedGroupSorterPattern);
  if (current.length + patched.length !== 1) return null;
  const isPatched = patched.length === 1;
  const match = (isPatched ? patched : current)[0];
  const [, name, order] = match;
  const calls = allMatches(source, sorterCallPattern(name, isPatched));
  if (calls.length !== 1 || allMatches(source, sorterCallPattern(name, !isPatched)).length !== 0) return null;
  const call = calls[0];
  const context = callContext(source, call);
  if (!context || (isPatched && (call[2] !== context.recency || call[3] !== context.mode))) return null;
  if (isPatched && !source.includes(patchedGroupSorter(name, order))) return null;
  return { isPatched, match, call, context, name, order };
}

function applyProjectGroupLastUpdatedSortPatch(source) {
  const found = contract(source);
  if (!found) {
    console.warn("WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch");
    return source;
  }
  if (found.isPatched) return source;
  const { match, call, context, name, order } = found;
  return source.replace(match[0], patchedGroupSorter(name, order))
    .replace(call[0], `${call[0].slice(0, -2)},getRecencyAt:${context.recency},sortMode:${context.mode}})`);
}

const descriptors = [{
  id: "last-updated-project-groups",
  phase: "webview-asset",
  order: 20_900,
  ciPolicy: "optional",
  pattern: /^[A-Za-z0-9_-]+\.js$/,
  assetMatch: (source) => contract(source) != null,
  missingDescription: "unique project group sort webview bundle",
  skipDescription: "project group Last updated sorting feature patch",
  apply: applyProjectGroupLastUpdatedSortPatch,
}];

module.exports = { applyProjectGroupLastUpdatedSortPatch, descriptors };
