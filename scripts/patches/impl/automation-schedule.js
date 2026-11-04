"use strict";

const { escapeRegExp, findMatchingBrace } = require("../lib/minified-js.js");

// The automation schedule owner lives in an rspack webview chunk. The current
// SWC output inlines the single-time helper into the parser result:
//   time:(t=p.byhour,n=p.byminute,r=p,i=ee(t),a=ee(n),
//         null!=i&&null!=a?es(i,a):r.dtstart?es(r.dtstart.getHours(),...):h)
// and the summary formats `e.time` through a module import call such as
// `(0,u.mm)(e.time,t)`. Injected helpers are declared next to their only
// caller and receive the combine/label functions as arguments, so they never
// depend on another function's scope.
const AUTOMATION_SCHEDULE_PATCH_MARKER = "function codexLinuxNormalizeRruleNumbers(";
const AUTOMATION_SCHEDULE_ASSET_NEEDLES = ["hasMultipleTimeValues:", "settings.automations.scheduleSummary.daily"];
const ID = "[A-Za-z_$][\\w$]*";
const CALLEE = `(?:\\(0,${ID}\\.${ID}\\)|${ID}(?:\\.${ID})?)`;

const TIMES_HELPER =
  "function codexLinuxNormalizeRruleNumbers(e,t,n){let r=Array.isArray(e)?e:[e];return Array.from(new Set(r.filter(e=>\"number\"==typeof e&&Number.isInteger(e)&&e>=t&&e<=n))).sort((e,t)=>e-t)}" +
  "function codexLinuxRruleTimes(e,t,n,a){let r=codexLinuxNormalizeRruleNumbers(e,0,23),i=codexLinuxNormalizeRruleNumbers(t,0,59);n.dtstart&&(0!==r.length||(r=[n.dtstart.getHours()]),0!==i.length||(i=[n.dtstart.getMinutes()]));let o=[];for(let e of r)for(let t of i)o.push(a(e,t));return Array.from(new Set(o)).sort()}";
const LABEL_HELPER =
  "function codexLinuxAutomationTimeLabel(e,t,a){let n=Array.isArray(e.timeValues)&&e.timeValues.length>0?e.timeValues:[e.time],r=n.map(e=>a(e,t)).filter(Boolean);return 0===r.length?null:\"function\"==typeof t.formatList?t.formatList(r,{type:\"conjunction\"}):r.join(\", \")}";

// Returns the factory body range of the rspack module that contains offset.
// Minified names are only unique inside one module factory, so every
// declaration lookup below is scoped to that range.
function rspackModuleRange(source, offset) {
  const start = source.indexOf("__webpack_modules__={");
  if (start < 0) return null;
  let index = start + "__webpack_modules__={".length;
  const header = new RegExp(`^,?(?:"[^"]+"|${ID}|\\d+)\\((?:${ID}(?:,${ID}){0,2})?\\)\\{`, "u");
  while (index < source.length) {
    const match = header.exec(source.slice(index, index + 200));
    if (match == null) return null;
    const open = index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) return null;
    if (open < offset && offset < close) return { start: open, end: close + 1 };
    index = close + 1;
  }
  return null;
}

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function namedFunction(source, name) {
  const declarations = [...source.matchAll(new RegExp(`(?<![\\w$])function ${escapeRegExp(name)}\\(([^)]*)\\)\\{`, "gu"))];
  if (declarations.length !== 1) return null;
  const [declaration] = declarations;
  const open = declaration.index + declaration[0].length - 1;
  const close = findMatchingBrace(source, open);
  return close < 0 ? null : { name, start: declaration.index, end: close + 1 };
}

function containingNamedFunction(source, offset) {
  const prefixStart = Math.max(0, offset - 8_000);
  const declarations = [...source.slice(prefixStart, offset).matchAll(new RegExp(`(?<![\\w$])function (${ID})\\(`, "gu"))];
  for (const declaration of declarations.reverse()) {
    const owner = namedFunction(source, declaration[1]);
    if (owner != null && owner.start === prefixStart + declaration.index && owner.end > offset) return owner;
  }
  return null;
}

function scheduleContract(source) {
  // Parser result: capture the options binding, the inlined single-time
  // expression and its combine function.
  const parser = uniqueMatch(source, new RegExp(
    `hasMultipleTimeValues:Array\\.isArray\\((${ID})\\.byhour\\)&&\\1\\.byhour\\.length>1\\|\\|` +
      `Array\\.isArray\\(\\1\\.byminute\\)&&\\1\\.byminute\\.length>1,` +
      `(interval:Math\\.max\\(1,Math\\.round\\(\\1\\.interval\\?\\?1\\)\\),(?:minute:${ID},)?` +
      `origOptions:${ID}\\.origOptions,rruleText:${ID},` +
      `time:\\((${ID})=\\1\\.byhour,(${ID})=\\1\\.byminute,(${ID})=\\1,(${ID})=(${CALLEE})\\(\\3\\),(${ID})=\\7\\(\\4\\),` +
      `null!=\\6&&null!=\\8\\?(${CALLEE})\\(\\6,\\8\\):\\5\\.dtstart\\?\\9\\(\\5\\.dtstart\\.getHours\\(\\),\\5\\.dtstart\\.getMinutes\\(\\)\\):${ID}\\)),` +
      `weekdays:${ID}\\}`,
    "gu",
  ));
  if (parser == null) return null;
  const options = parser[1];
  const combine = parser[9];
  const parserOwner = containingNamedFunction(source, parser.index);
  if (parserOwner == null) return null;

  // Summary: the only consumer that formats `e.time` after rejecting
  // multi-time rules, called directly with the parser's result.
  const summaries = [...source.matchAll(new RegExp(
    `(?<![\\w$])function (${ID})\\(e,t(?:,${ID}=![01])?\\)\\{if\\(!e\\|\\|e\\.hasMultipleTimeValues\\)return null;`,
    "gu",
  ))].map((head) => namedFunction(source, head[1])).filter(Boolean);
  if (summaries.length !== 1) return null;
  const [summary] = summaries;
  if (summary.start < parserOwner.end && parserOwner.start < summary.end) return null;
  const summarySource = source.slice(summary.start, summary.end);
  const label = uniqueMatch(summarySource, new RegExp(`let (${ID})=(${CALLEE})\\(e\\.time,t\\);return \\1\\?`, "gu"));
  if (label == null) return null;
  const ownerCalls = [...source.matchAll(new RegExp(
    `(?<![\\w$.])${escapeRegExp(summary.name)}\\(${escapeRegExp(parserOwner.name)}\\(`,
    "gu",
  ))];
  if (ownerCalls.length !== 1) return null;

  return { parser, options, combine, parserOwner, summary, summarySource, label };
}

function matchesAutomationScheduleContract(source) {
  return source.includes(AUTOMATION_SCHEDULE_PATCH_MARKER) || scopedScheduleContract(source) != null;
}

function hasCompleteAutomationSchedulePatch(source) {
  return [
    AUTOMATION_SCHEDULE_PATCH_MARKER,
    "function codexLinuxRruleTimes(",
    "function codexLinuxAutomationTimeLabel(",
    "timeValues:codexLinuxRruleTimes(",
    "=codexLinuxAutomationTimeLabel(e,t,",
  ].every((needle) => source.split(needle).length === 2);
}

function scopedScheduleContract(source) {
  const anchor = source.indexOf("hasMultipleTimeValues:Array.isArray(");
  if (anchor < 0 || source.indexOf("hasMultipleTimeValues:Array.isArray(", anchor + 1) >= 0) return null;
  const range = rspackModuleRange(source, anchor);
  if (range == null) return null;
  const contract = scheduleContract(source.slice(range.start, range.end));
  return contract == null ? null : { ...contract, offset: range.start };
}

function applyAutomationScheduleMultiTimePatch(source) {
  if (source.includes(AUTOMATION_SCHEDULE_PATCH_MARKER)) {
    if (!hasCompleteAutomationSchedulePatch(source)) {
      console.warn("WARN: Found incomplete or ambiguous automation schedule patch — leaving bundle unchanged");
    }
    return source;
  }

  const contract = scopedScheduleContract(source);
  if (contract == null) {
    console.warn("WARN: Could not find automation schedule parser and summary contract — skipping RRULE multi-time patch");
    return source;
  }
  const { parser, options, combine, parserOwner, summary, summarySource, label, offset } = contract;
  const times = `codexLinuxRruleTimes(${options}.byhour,${options}.byminute,${options},${combine})`;
  const parserPatch =
    `hasMultipleTimeValues:${times}.length>1,${parser[2]},timeValues:${times},` +
    parser[0].slice(parser[0].lastIndexOf("weekdays:"));
  const summaryPatch = summarySource
    .replace("if(!e||e.hasMultipleTimeValues)return null;", "if(!e)return null;")
    .replace(
      label[0],
      `let ${label[1]}=codexLinuxAutomationTimeLabel(e,t,(e,t)=>${label[2]}(e,t));return ${label[1]}?`,
    );

  // Each helper is declared in the same scope as its only caller. Apply edits
  // from the end of the file so earlier offsets stay valid.
  const edits = [
    { start: offset + parserOwner.start, end: offset + parserOwner.start, text: TIMES_HELPER },
    { start: offset + parser.index, end: offset + parser.index + parser[0].length, text: parserPatch },
    { start: offset + summary.start, end: offset + summary.end, text: LABEL_HELPER + summaryPatch },
  ].sort((a, b) => b.start - a.start);
  let patched = source;
  for (const edit of edits) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  return patched;
}

module.exports = {
  AUTOMATION_SCHEDULE_ASSET_NEEDLES,
  applyAutomationScheduleMultiTimePatch,
  matchesAutomationScheduleContract,
};
