"use strict";

const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");

const identifier = String.raw`[A-Za-z_$][\w$]*`;
// The current task sorter selects populated and pending local timestamps in
// one inline function. Other task kinds retain its implicit undefined result.
const comparatorPattern = new RegExp(
  String.raw`function(?: ${identifier})?\((${identifier}),(${identifier})\)\{if\("local"===\1\.kind\)return `,
  "g",
);

function currentLocalTimestamp(task, mode) {
  return `null==${task}.summary?${task}.at:` +
    `"updated_at"===${mode}?${task}.summary.recencyAt??${task}.summary.updatedAt:${task}.summary.createdAt`;
}

function patchedLocalTimestamp(task, mode) {
  return currentLocalTimestamp(task, mode) +
    `??(/^local:[\\da-f]{8}-[\\da-f]{4}-7[\\da-f]{3}-[89ab][\\da-f]{3}-[\\da-f]{12}$/i.test(${task}.key)?Number.parseInt(${task}.key.slice(6).replaceAll("-","").slice(0,12),16):${task}.summary.recencyAt??${task}.summary.updatedAt)`;
}

function comparatorContracts(source) {
  const candidates = [];
  const current = [];
  const patched = [];
  const matches = [...source.matchAll(comparatorPattern)];
  if (matches.length === 0) return { candidates, current, patched };
  const lexical = createJavaScriptLexicalIndex(source);
  for (const match of matches) {
    if (!lexical.isCode(match.index)) continue;
    const open = match.index + match[0].indexOf("{"), end = lexical.matchingBrace(open);
    if (end < open) continue;
    const [, task, mode] = match;
    const localTimestamp = source.slice(match.index + match[0].length, end);
    const contract = { index: match.index, text: source.slice(match.index, end + 1), task, mode, localTimestamp };
    candidates.push(contract);
    if (localTimestamp === currentLocalTimestamp(task, mode)) current.push(contract);
    if (localTimestamp === patchedLocalTimestamp(task, mode)) patched.push(contract);
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
  const { task, mode } = match;
  const patchedComparator = match.text.replace(
    currentLocalTimestamp(task, mode),
    patchedLocalTimestamp(task, mode),
  );
  return source.slice(0, match.index) + patchedComparator + source.slice(match.index + match.text.length);
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
    assetNeedles: [".summary.recencyAt", ".summary.createdAt"],
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
