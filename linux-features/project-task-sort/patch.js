"use strict";

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const comparatorPattern = new RegExp(
  String.raw`function (${identifier})\((${identifier}),(${identifier})\)\{switch\(\2\.kind\)\{case\`local\`:return ([^;]+);case\`remote\`:return\(\(\3===\`updated_at\`\?\2\.task\.updated_at\?\?\2\.task\.created_at:\2\.task\.created_at\?\?\2\.task\.updated_at\)\?\?0\)\*1e3\}\}`,
  "g",
);

function currentLocalTimestamp(task, mode) {
  return `${task}.conversation==null?${task}.at:${mode}===\`updated_at\`?${task}.conversation.recencyAt??${task}.conversation.updatedAt:${task}.conversation.createdAt`;
}

function patchedLocalTimestamp(task, mode) {
  return currentLocalTimestamp(task, mode) +
    `??(/^local:[\\da-f]{8}-[\\da-f]{4}-7[\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}$/i.test(${task}.key)?Number.parseInt(${task}.key.slice(6).replaceAll(\`-\`,\`\`).slice(0,12),16):${task}.conversation.recencyAt??${task}.conversation.updatedAt)`;
}

function comparatorContracts(source) {
  const candidates = [];
  const current = [];
  const patched = [];
  for (const match of source.matchAll(new RegExp(comparatorPattern.source, comparatorPattern.flags))) {
    candidates.push(match);
    const [, , task, mode, localTimestamp] = match;
    if (localTimestamp === currentLocalTimestamp(task, mode)) current.push(match);
    if (localTimestamp === patchedLocalTimestamp(task, mode)) patched.push(match);
  }
  return { candidates, current, patched };
}

function warnAndPreserve(source) {
  console.warn(
    "WARN: Could not find one unique current project task timestamp comparator - skipping project task sort feature patch",
  );
  return source;
}

function applyProjectTaskSortPatch(source) {
  const { candidates, current, patched } = comparatorContracts(source);
  if (candidates.length === 1 && patched.length === 1 && current.length === 0) return source;
  if (candidates.length !== 1 || current.length !== 1 || patched.length !== 0) {
    return warnAndPreserve(source);
  }

  const match = current[0];
  const task = match[2];
  const mode = match[3];
  const patchedComparator = match[0].replace(
    currentLocalTimestamp(task, mode),
    patchedLocalTimestamp(task, mode),
  );
  return source.slice(0, match.index) + patchedComparator + source.slice(match.index + match[0].length);
}

function matchesProjectTaskSortContract(source) {
  const { candidates, current, patched } = comparatorContracts(source);
  return candidates.length === 1 && current.length + patched.length === 1;
}

const descriptors = [
  {
    id: "creation-time",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    pattern: /^[A-Za-z0-9_-]+\.js$/,
    assetMatch: matchesProjectTaskSortContract,
    missingDescription: "unique project task timestamp comparator",
    skipDescription: "project task creation timestamp feature patch",
    apply: applyProjectTaskSortPatch,
  },
];

module.exports = {
  applyProjectTaskSortPatch,
  matchesProjectTaskSortContract,
  descriptors,
};
