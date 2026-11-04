"use strict";

const path = require("node:path");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const upstream = require("../../scripts/patches/impl/automation-schedule.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const CALLEE = `(?:\\(0,${ID}\\.${ID}\\)|${ID}(?:\\.${ID})?)`;
const HELPERS = ["codexLinuxNormalizeRruleNumbers", "codexLinuxRruleTimes", "codexLinuxAutomationTimeLabel"];
const RESERVED = new RegExp(`\\b(?:${HELPERS.join("|")})\\b`, "u");

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function atFactoryScope(body, offset) {
  const prefix = body.slice(0, offset);
  return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1;
}

function inCode(body, offset) {
  const prefix = "{" + body.slice(0, offset);
  // Closing braces cannot escape an unfinished string, template, regex or
  // comment. Extra closers are never evaluated; the brace lexer stops once
  // the surrounding synthetic block closes.
  return findMatchingBrace(prefix + "}".repeat(prefix.length + 1), 0) >= prefix.length;
}

function currentScheduleContract(source) {
  if (!upstream.matchesAutomationScheduleContract(source)) return false;
  try {
    const anchor = source.indexOf("hasMultipleTimeValues:Array.isArray(");
    const owners = [...rspackModuleFactories(source, "automation-schedule.js")]
      .filter((module) => module.start <= anchor && anchor < module.end);
    if (owners.length !== 1) return false;
    const [{ moduleSource: body, start }] = owners;
    const offset = anchor - start;
    if (!inCode(body, offset)) return false;
    const functions = [...body.matchAll(new RegExp(`\\bfunction ${ID}\\([^)]*\\)\\{`, "gu"))];
    const containing = functions.filter((head) => head.index < offset &&
      findMatchingBrace(body, head.index + head[0].length - 1) > offset);
    const parser = containing.at(-1);
    const summary = unique(body, new RegExp(
      `\\bfunction ${ID}\\(e,t(?:,${ID}=![01])?\\)\\{if\\(!e\\|\\|e\\.hasMultipleTimeValues\\)return null;`, "gu"));
    return parser != null && summary != null &&
      atFactoryScope(body, parser.index) && atFactoryScope(body, summary.index);
  } catch {
    return false;
  }
}

function removeHelpers(source) {
  const edits = [];
  const modules = [...rspackModuleFactories(source, "automation-schedule.js")];
  for (const name of HELPERS) {
    const head = unique(source, new RegExp(`\\bfunction ${name}\\([^)]*\\)\\{`, "gu"));
    if (head == null) return null;
    const owner = modules.find((module) => module.start <= head.index && head.index < module.end);
    if (owner == null || !atFactoryScope(owner.moduleSource, head.index - owner.start)) return null;
    const end = findMatchingBrace(source, head.index + head[0].length - 1);
    if (end < 0) return null;
    edits.push({ start: head.index, end: end + 1 });
  }
  for (const { start, end } of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + source.slice(end);
  }
  return source;
}

// Recover only the upstream parser/summary projection, then regenerate with
// the retained upstream transform. Byte equality proves every helper body,
// boundary, caller binding and insertion scope, rather than five marker counts.
function restoreCurrentSchedule(source) {
  let restored = removeHelpers(source);
  if (restored == null) return null;
  const multiple = unique(restored, new RegExp(
    `hasMultipleTimeValues:codexLinuxRruleTimes\\((${ID})\\.byhour,\\1\\.byminute,\\1,(${CALLEE})\\)\\.length>1,`, "gu"));
  if (multiple == null) return null;
  const options = multiple[1];
  const call = `codexLinuxRruleTimes(${options}.byhour,${options}.byminute,${options},${multiple[2]})`;
  const values = unique(restored, new RegExp(`,timeValues:${escapeRegExp(call)},(?=weekdays:${ID}\\})`, "gu"));
  if (values == null) return null;
  const label = unique(restored, new RegExp(
    `let (${ID})=codexLinuxAutomationTimeLabel\\(e,t,\\(e,t\\)=>(${CALLEE})\\(e,t\\)\\);return \\1\\?`, "gu"));
  if (label == null) return null;
  const heads = [...restored.matchAll(new RegExp(
    `\\bfunction (${ID})\\(e,t(?:,${ID}=![01])?\\)\\{if\\(!e\\)return null;`, "gu"))];
  const summaries = heads.filter((head) => {
    const end = findMatchingBrace(restored, head.index + head[0].indexOf("{"));
    return head.index < label.index && end > label.index;
  });
  if (summaries.length !== 1) return null;
  const edits = [
    { start: multiple.index, end: multiple.index + multiple[0].length,
      text: `hasMultipleTimeValues:Array.isArray(${options}.byhour)&&${options}.byhour.length>1||Array.isArray(${options}.byminute)&&${options}.byminute.length>1,` },
    { start: values.index, end: values.index + values[0].length, text: "," },
    { start: label.index, end: label.index + label[0].length, text: `let ${label[1]}=${label[2]}(e.time,t);return ${label[1]}?` },
    { start: summaries[0].index, end: summaries[0].index + summaries[0][0].length,
      text: summaries[0][0].replace("if(!e)return null;", "if(!e||e.hasMultipleTimeValues)return null;") },
  ];
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start)) {
    restored = restored.slice(0, start) + text + restored.slice(end);
  }
  return RESERVED.test(restored) ? null : restored;
}

function automationScheduleState(source) {
  if (typeof source !== "string") return "invalid";
  try {
    if (!RESERVED.test(source)) return currentScheduleContract(source) ? "current" : "invalid";
    const restored = restoreCurrentSchedule(source);
    if (restored == null || !currentScheduleContract(restored)) return "invalid";
    return upstream.applyAutomationScheduleMultiTimePatch(restored) === source ? "patched" : "invalid";
  } catch {
    return "invalid";
  }
}

function matchesAutomationScheduleContract(source) {
  return automationScheduleState(source) !== "invalid";
}

// Keep incomplete candidates visible to the production asset transaction. A
// valid chunk alongside a damaged copy is ambiguous, not a unique valid owner.
function isAutomationScheduleCandidate(source) {
  return typeof source === "string" && (RESERVED.test(source) ||
    upstream.AUTOMATION_SCHEDULE_ASSET_NEEDLES.every((needle) => source.includes(needle)));
}

function applyAutomationScheduleMultiTimePatch(source) {
  const state = automationScheduleState(source);
  if (state === "patched") return source;
  if (state !== "current") {
    console.warn("WARN: Could not prove one complete automation schedule parser and summary — leaving bundle unchanged");
    return source;
  }
  const patched = upstream.applyAutomationScheduleMultiTimePatch(source);
  if (automationScheduleState(patched) === "patched") return patched;
  console.warn("WARN: Automation schedule poststate verification failed — leaving bundle unchanged");
  return source;
}

const MODULE_PREFIX = "export const __webpack_modules__={ScheduleOwner(e,t,n){";
const MODULE_SUFFIX = "}};";
const asChunk = (body) => MODULE_PREFIX + body + MODULE_SUFFIX;

function applyAutomationScheduleToApp(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assetsDir, {
    description: "automation schedule parser and summary",
    sourceMatch: isAutomationScheduleCandidate,
    matchModule: (body) => automationScheduleState(asChunk(body)) !== "invalid",
  });
  // A valid module does not authorize ignoring an extra partial helper outside
  // its factory. The whole owning chunk must also prove one canonical state.
  for (const copy of copies) {
    if (automationScheduleState(copy.source) === "invalid") {
      throw new Error("Incomplete automation schedule module or helper scope");
    }
  }
  return patchRspackModuleCopies(assetsDir, copies, (body) => {
    const source = asChunk(body);
    if (automationScheduleState(source) === "invalid") {
      throw new Error("Incomplete automation schedule module");
    }
    const patched = applyAutomationScheduleMultiTimePatch(source);
    if (automationScheduleState(patched) !== "patched") {
      throw new Error("Automation schedule module poststate verification failed");
    }
    return patched.slice(MODULE_PREFIX.length, -MODULE_SUFFIX.length);
  });
}

module.exports = {
  AUTOMATION_SCHEDULE_ASSET_NEEDLES: upstream.AUTOMATION_SCHEDULE_ASSET_NEEDLES,
  applyAutomationScheduleMultiTimePatch,
  applyAutomationScheduleToApp,
  automationScheduleState,
  isAutomationScheduleCandidate,
  matchesAutomationScheduleContract,
};
