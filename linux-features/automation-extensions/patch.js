"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  AUTOMATION_SCHEDULE_ASSET_NEEDLES,
  applyAutomationScheduleMultiTimePatch,
  matchesAutomationScheduleContract,
} = require("../../scripts/patches/impl/automation-schedule.js");
const {
  AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");

// Current rspack chunks may encode factories as either `id(e,t,n){...}` or
// `id:(function(e,t,n){...})`. The shared automation patch predates the latter
// shape, so isolate the unique semantic owner and present only that factory to
// it. This keeps ownership fail-closed without depending on a chunk name.
function scheduleOwner(source) {
  const anchor = source.indexOf("hasMultipleTimeValues:Array.isArray(");
  if (anchor < 0 || source.indexOf("hasMultipleTimeValues:Array.isArray(", anchor + 1) >= 0) return null;
  const marker = "__webpack_modules__={";
  let cursor = source.indexOf(marker);
  if (cursor < 0) return null;
  cursor += marker.length;
  const header = /(?:[\w$]+|"[^"\\]*")(?:(?:\([\w$]*(?:,[\w$]+){0,2}\))|(?::(\()?function\([\w$]*(?:,[\w$]+){0,2}\)))\{/y;
  while (cursor < source.length && source[cursor] !== "}") {
    header.lastIndex = cursor;
    const match = header.exec(source);
    if (match == null) return null;
    const open = header.lastIndex - 1;
    const end = findMatchingBrace(source, open);
    if (end < 0) return null;
    if (open < anchor && anchor < end) return { open, end };
    cursor = end + 1;
    if (match[1] != null && source[cursor] === ")") cursor += 1;
    if (source[cursor] === ",") cursor += 1;
  }
  return null;
}

function wrappedSchedule(source, operation) {
  if (source.includes("function codexLinuxNormalizeRruleNumbers(")) return source;
  const owner = scheduleOwner(source);
  if (owner == null) return operation === "matches" ? false : source;
  const prefix = "export const __webpack_modules__={X(e,t,n){";
  const suffix = "}};";
  const body = source.slice(owner.open + 1, owner.end);
  const wrapped = prefix + body + suffix;
  if (operation === "matches") return matchesAutomationScheduleContract(wrapped);
  const patched = applyAutomationScheduleMultiTimePatch(wrapped);
  if (patched === wrapped || !patched.startsWith(prefix) || !patched.endsWith(suffix)) return source;
  return source.slice(0, owner.open + 1) + patched.slice(prefix.length, -suffix.length) + source.slice(owner.end);
}

// Both owners live in rspack webview chunks with content-hashed names, so
// they are located by stable content needles plus a unique semantic contract.
module.exports = [
  webviewAssetPatch({
    id: "multi-time-rrule",
    phase: "webview-asset",
    order: 20_100,
    ciPolicy: "optional",
    assetNeedles: AUTOMATION_SCHEDULE_ASSET_NEEDLES,
    assetMatch: (source) => wrappedSchedule(source, "matches"),
    missingDescription: "automation schedule bundle",
    skipDescription: "RRULE multi-time patch",
    apply: (source) => wrappedSchedule(source, "apply"),
  }),
  webviewAssetPatch({
    id: "eager-automation-update",
    phase: "webview-asset",
    order: 20_110,
    ciPolicy: "optional",
    assetNeedles: AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
    assetMatch: matchesAutomationUpdateEagerToolContract,
    missingDescription: "dynamic Codex app tools bundle",
    skipDescription: "automation_update eager dynamic tool patch",
    apply: applyAutomationUpdateEagerToolPatch,
  }),
];
