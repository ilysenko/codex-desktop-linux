"use strict";

const currentCreationTime =
  "case`local`:return e.conversation==null?e.pendingWorktree.createdAt:t===`updated_at`?e.conversation.recencyAt??e.conversation.updatedAt:e.conversation.createdAt";
const patchedCreationTime =
  currentCreationTime +
  "??(/^local:[\\da-f]{8}-[\\da-f]{4}-7[\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}$/i.test(e.key)?Number.parseInt(e.key.slice(6).replaceAll(`-`,``).slice(0,12),16):e.conversation.recencyAt??e.conversation.updatedAt)";

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyProjectTaskSortPatch(source) {
  const currentCount = countOccurrences(source, currentCreationTime);
  const patchedCount = countOccurrences(source, patchedCreationTime);
  const unpatchedCount = currentCount - patchedCount;

  if (patchedCount === 1 && unpatchedCount === 0) {
    return source;
  }

  if (
    !source.includes("sidebarElectron.sortMenu.manual") ||
    !source.includes("sidebarElectron.sortMenu.created")
  ) {
    console.warn(
      "WARN: Could not find current project task sort menu markers - skipping project task sort feature patch",
    );
    return source;
  }

  if (unpatchedCount !== 1 || patchedCount !== 0) {
    console.warn(
      "WARN: Could not find current project task creation timestamp insertion point - skipping project task sort feature patch",
    );
    return source;
  }

  return source.replace(currentCreationTime, patchedCreationTime);
}

const descriptors = [
  {
    id: "creation-time",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    pattern:
      /^app-initial~app-main~projects-index-page~remote-conversation-page-[A-Za-z0-9_-]+\.js$/,
    missingDescription: "project task sort webview bundle",
    skipDescription: "project task creation timestamp feature patch",
    apply: applyProjectTaskSortPatch,
  },
];

module.exports = {
  applyProjectTaskSortPatch,
  descriptors,
};
