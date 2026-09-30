"use strict";

const identifier = String.raw`[A-Za-z_$][\w$]*`;
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentSorterCallPattern(sorterName) {
  return new RegExp(
    String.raw`${escapeRegExp(sorterName)}\(\{groups:(${identifier}\(\{groups:${identifier},items:(${identifier})\}\)),projectOrder:(${identifier}\(${identifier},${identifier}\.PROJECT_ORDER\))\}\)`,
    "g",
  );
}

function patchedSorterCallPattern(sorterName) {
  return new RegExp(
    String.raw`${escapeRegExp(sorterName)}\(\{groups:${identifier}\(\{groups:${identifier},items:${identifier}\}\),projectOrder:${identifier}\(${identifier},${identifier}\.PROJECT_ORDER\),getRecencyAt:${identifier},sortMode:${identifier}\}\)`,
    "g",
  );
}

function projectSortModeBefore(source, callIndex) {
  const prefix = source.slice(Math.max(0, callIndex - 1500), callIndex);
  const matches = [...prefix.matchAll(new RegExp(String.raw`projectSortMode:(${identifier})`, "g"))];
  return matches.length === 1 ? matches[0][1] : null;
}

function patchedGroupSorter(sorterName, orderFunction) {
  return `function ${sorterName}({groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode}){if(codexLinuxProjectSortMode!==\`updated_at\`)return ${orderFunction}(e,n);return e.map((e,n)=>({group:e,index:n,recencyAt:e.threadKeys.reduce((e,n)=>Math.max(e,t(n)??0),e.projectUpdatedAt??0)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e)}`;
}

function applyProjectGroupLastUpdatedSortPatch(source) {
  const currentSorters = allMatches(source, currentGroupSorterPattern);
  const patchedSorters = allMatches(source, patchedGroupSorterPattern);

  if (patchedSorters.length === 1 && currentSorters.length === 0) {
    const [sorterName] = patchedSorters[0].slice(1);
    const patchedCalls = allMatches(source, patchedSorterCallPattern(sorterName));
    const currentCalls = allMatches(source, currentSorterCallPattern(sorterName));
    if (patchedCalls.length === 1 && currentCalls.length === 0) return source;
  }

  if (currentSorters.length !== 1 || patchedSorters.length !== 0) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  const [sorterName, orderFunction] = currentSorters[0].slice(1);
  const currentCalls = allMatches(source, currentSorterCallPattern(sorterName));
  const patchedCalls = allMatches(source, patchedSorterCallPattern(sorterName));
  if (currentCalls.length !== 1 || patchedCalls.length !== 0) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  // The current sidebar stores references, not task/recency records. Reuse
  // the same recency getter that upstream uses for the adjacent chat sorter.
  const itemsVar = currentCalls[0][2];
  const nextCall = source.slice(currentCalls[0].index + currentCalls[0][0].length);
  const recencyContract = nextCall.match(new RegExp(
    String.raw`^,${identifier}=${identifier}\(\{explicitChatThreadKeys:${identifier},getRecencyAt:(${identifier}),items:(${identifier}),projectGroups:${identifier},projectlessThreadIds:`,
  ));
  const recencyGetter = recencyContract?.[2] === itemsVar ? recencyContract[1] : null;
  const sortMode = projectSortModeBefore(source, currentCalls[0].index);
  if (recencyGetter == null || sortMode == null) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  const call = currentCalls[0][0];
  const patchedCall = `${call.slice(0, -2)},getRecencyAt:${recencyGetter},sortMode:${sortMode}})`;
  return source
    .replace(currentSorters[0][0], patchedGroupSorter(sorterName, orderFunction))
    .replace(call, patchedCall);
}

const descriptors = [
  {
    id: "last-updated-project-groups",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    pattern: /^app-initial-[A-Za-z0-9_-]+\.js$/,
    missingDescription: "project group sort webview bundle",
    skipDescription: "project group Last updated sorting feature patch",
    apply: applyProjectGroupLastUpdatedSortPatch,
  },
];

module.exports = {
  applyProjectGroupLastUpdatedSortPatch,
  descriptors,
};
