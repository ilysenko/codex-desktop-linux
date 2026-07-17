"use strict";

const currentGroupSorter =
  "function Fe({groups:e,items:t,projectOrder:n}){let r=new Map(t.map(e=>[e.task.key,e.recencyAt]));return ue(e.map((e,t)=>({group:e,index:t,recencyAt:Re(e,r)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e),n)}";
const patchedGroupSorter =
  "function Fe({groups:e,items:t,projectOrder:n,sortMode:codexLinuxProjectSortMode}){let r=new Map(t.map(e=>[e.task.key,e.recencyAt]));return((codexLinuxRecencySortedGroups)=>codexLinuxProjectSortMode===`updated_at`?codexLinuxRecencySortedGroups:ue(codexLinuxRecencySortedGroups,n))(e.map((e,t)=>({group:e,index:t,recencyAt:Re(e,r)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e))}";

const currentGroupSorterCall =
  "T=Fe({groups:Pe({groups:S,items:c}),items:c,projectOrder:f(t,o.PROJECT_ORDER)})";
const patchedGroupSorterCall =
  "T=Fe({groups:Pe({groups:S,items:c}),items:c,projectOrder:f(t,o.PROJECT_ORDER),sortMode:t(C).projectSortMode})";

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyProjectGroupLastUpdatedSortPatch(source) {
  const currentSorterCount = countOccurrences(source, currentGroupSorter);
  const patchedSorterCount = countOccurrences(source, patchedGroupSorter);
  const currentCallCount = countOccurrences(source, currentGroupSorterCall);
  const patchedCallCount = countOccurrences(source, patchedGroupSorterCall);

  if (
    patchedSorterCount === 1 &&
    patchedCallCount === 1 &&
    currentSorterCount === 0 &&
    currentCallCount === 0
  ) {
    return source;
  }

  if (
    currentSorterCount !== 1 ||
    patchedSorterCount !== 0 ||
    currentCallCount !== 1 ||
    patchedCallCount !== 0
  ) {
    console.warn(
      "WARN: Could not find current project group sorting insertion points - skipping project group Last updated sort feature patch",
    );
    return source;
  }

  return source
    .replace(currentGroupSorter, patchedGroupSorter)
    .replace(currentGroupSorterCall, patchedGroupSorterCall);
}

const descriptors = [
  {
    id: "last-updated-project-groups",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    pattern:
      /^app-initial~app-main~onboarding-page~projects-index-page~quick-chat-window-page~codex-micro~[A-Za-z0-9_-]+\.js$/,
    missingDescription: "project group sort webview bundle",
    skipDescription: "project group Last updated sorting feature patch",
    apply: applyProjectGroupLastUpdatedSortPatch,
  },
];

module.exports = {
  applyProjectGroupLastUpdatedSortPatch,
  descriptors,
};
