"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  findLastRegexMatch,
} = require("../lib/minified-js.js");
const {
  readDirectoryNames,
} = require("../lib/assets.js");

const AUTOMATION_SCHEDULE_PATCH_MARKER = "function codexLinuxNormalizeRruleNumbers(";
const MINIFIED_IDENTIFIER = "[A-Za-z_$][\\w$]*";

function findContainingNamedFunction(source, offset) {
  const prefixStart = Math.max(0, offset - 4_000);
  return findLastRegexMatch(
    source.slice(prefixStart, offset),
    new RegExp(`function (${MINIFIED_IDENTIFIER})\\([^)]*\\)\\{`, "gu"),
  )?.[1] ?? null;
}

function findWorkspaceRootDropHandlerBundles(extractedDir) {
  const candidateDirs = [
    path.join(extractedDir, ".vite", "build"),
    path.join(extractedDir, "webview", "assets"),
  ];
  return candidateDirs
    .flatMap((dir) =>
      readDirectoryNames(dir)
        .filter((name) => name.endsWith(".js"))
        .sort()
        .map((name) => path.join(dir, name)),
    )
    .filter((candidate) => {
      try {
        const source = fs.readFileSync(candidate, "utf8");
        return source.includes(AUTOMATION_SCHEDULE_PATCH_MARKER) ||
          (
            source.includes("hasMultipleTimeValues") &&
            new RegExp(`rruleText:${MINIFIED_IDENTIFIER},time:${MINIFIED_IDENTIFIER}\\((${MINIFIED_IDENTIFIER})\\.byhour,\\1\\.byminute,\\1\\)`).test(source)
          );
      } catch {
        return false;
      }
    });
}

function applyAutomationScheduleMultiTimePatch(source) {
  if (source.includes("function codexLinuxNormalizeRruleNumbers(")) {
    return source;
  }

  const patched = applyGenericAutomationScheduleMultiTimePatch(source);
  if (patched === source) {
    console.warn("WARN: Could not find automation schedule helper block — skipping RRULE multi-time patch");
  }
  return patched;
}

function applyGenericAutomationScheduleMultiTimePatch(source) {
  if (source.includes("function codexLinuxNormalizeRruleNumbers(")) {
    return source;
  }

  const parserRe = new RegExp(
    `hasMultipleTimeValues:Array\\.isArray\\((${MINIFIED_IDENTIFIER})\\.byhour\\)&&\\1\\.byhour\\.length>1\\|\\|Array\\.isArray\\(\\1\\.byminute\\)&&\\1\\.byminute\\.length>1,` +
      `interval:Math\\.max\\(1,Math\\.round\\(\\1\\.interval\\?\\?1\\)\\),(minute:(${MINIFIED_IDENTIFIER}),)?` +
      `origOptions:(${MINIFIED_IDENTIFIER})\\.origOptions,rruleText:(${MINIFIED_IDENTIFIER}),time:(${MINIFIED_IDENTIFIER})\\(\\1\\.byhour,\\1\\.byminute,\\1\\),weekdays:(${MINIFIED_IDENTIFIER})`,
  );
  const parserMatches = [...source.matchAll(new RegExp(parserRe.source, "gu"))];
  if (parserMatches.length !== 1) {
    return source;
  }
  const [parserMatch] = parserMatches;
  const optionsVar = parserMatch[1];
  const minuteProperty = parserMatch[2] == null ? "" : `minute:${parserMatch[3]},`;
  const originalOptionsVar = parserMatch[4];
  const rruleTextVar = parserMatch[5];
  const timeFn = parserMatch[6];
  const weekdaysVar = parserMatch[7];

  const helperRe = new RegExp(
    "function " +
      timeFn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      `\\(e,t,n\\)\\{let r=(${MINIFIED_IDENTIFIER})\\(e\\),i=\\1\\(t\\);return r!=null&&i!=null\\?(${MINIFIED_IDENTIFIER})\\(r,i\\):n\\.dtstart\\?\\2\\(n\\.dtstart\\.getHours\\(\\),n\\.dtstart\\.getMinutes\\(\\)\\):(${MINIFIED_IDENTIFIER})\\}function \\1\\(e\\)\\{return Array\\.isArray\\(e\\)\\?typeof e\\[0\\]==\`number\`\\?e\\[0\\]:null:typeof e==\`number\`\\?e:null\\}`,
  );
  const helperMatches = [...source.matchAll(new RegExp(helperRe.source, "gu"))];
  if (helperMatches.length !== 1) {
    return source;
  }
  const [helperMatch] = helperMatches;
  const helperBlock = helperMatch[0];
  const combineFn = helperMatch[2];

  const summaryRe = new RegExp(
    `function (${MINIFIED_IDENTIFIER})\\(e,t(?:,${MINIFIED_IDENTIFIER}=!0)?\\)\\{if\\(!e\\|\\|e\\.hasMultipleTimeValues\\)return null;[\\s\\S]*?let (${MINIFIED_IDENTIFIER})=(${MINIFIED_IDENTIFIER})\\(e\\.time,t\\);return \\2\\?(${MINIFIED_IDENTIFIER})\\(\\{intl:t,isEveryDay:${MINIFIED_IDENTIFIER},timeLabel:\\2,weekdays:${MINIFIED_IDENTIFIER}\\}\\):null\\}`,
  );
  const summaryMatches = [...source.matchAll(new RegExp(summaryRe.source, "gu"))];
  if (summaryMatches.length !== 1) {
    return source;
  }
  const [summaryMatch] = summaryMatches;
  const summaryBlock = summaryMatch[0];
  const summaryFn = summaryMatch[1];
  const summaryLabelVar = summaryMatch[2];
  const labelFn = summaryMatch[3];
  const parserFn = findContainingNamedFunction(source, parserMatch.index);
  if (parserFn == null) {
    return source;
  }
  const ownerCallRe = new RegExp(
    `${summaryFn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(${parserFn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`,
    "gu",
  );
  const ownerCalls = [...source.matchAll(ownerCallRe)];
  if (ownerCalls.length !== 1) {
    return source;
  }

  const helperPatch =
    helperBlock +
    "function codexLinuxNormalizeRruleNumbers(e,t,n){let r=Array.isArray(e)?e:[e];return Array.from(new Set(r.filter(e=>typeof e==`number`&&Number.isInteger(e)&&e>=t&&e<=n))).sort((e,t)=>e-t)}" +
    "function codexLinuxRruleTimes(e,t,n){let r=codexLinuxNormalizeRruleNumbers(e,0,23),i=codexLinuxNormalizeRruleNumbers(t,0,59);n.dtstart&&(r.length!==0||(r=[n.dtstart.getHours()]),i.length!==0||(i=[n.dtstart.getMinutes()]));let a=[];for(let e of r)for(let t of i)a.push(" +
    combineFn +
    "(e,t));return Array.from(new Set(a)).sort()}" +
    "function codexLinuxAutomationTimeLabel(e,t){let n=Array.isArray(e.timeValues)&&e.timeValues.length>0?e.timeValues:[e.time],r=n.map(e=>" +
    labelFn +
    "(e,t)).filter(Boolean);return r.length===0?null:typeof t.formatList==`function`?t.formatList(r,{type:`conjunction`}):r.join(`, `)}";

  const parserPatch =
    `hasMultipleTimeValues:codexLinuxRruleTimes(${optionsVar}.byhour,${optionsVar}.byminute,${optionsVar}).length>1,interval:Math.max(1,Math.round(${optionsVar}.interval??1)),` + minuteProperty + `origOptions:${originalOptionsVar}.origOptions,rruleText:${rruleTextVar},time:` +
    timeFn +
    `(${optionsVar}.byhour,${optionsVar}.byminute,${optionsVar}),timeValues:codexLinuxRruleTimes(${optionsVar}.byhour,${optionsVar}.byminute,${optionsVar}),weekdays:${weekdaysVar}`;

  const summaryPatch = summaryBlock
    .replace("if(!e||e.hasMultipleTimeValues)return null;", "if(!e)return null;")
    .replace(
      "let " + summaryLabelVar + "=" + labelFn + "(e.time,t);",
      "let " + summaryLabelVar + "=codexLinuxAutomationTimeLabel(e,t);",
    );

  let patched = source.replace(helperBlock, () => helperPatch);
  patched = patched.replace(parserMatch[0], () => parserPatch);
  patched = patched.replace(summaryBlock, () => summaryPatch);
  return patched;
}

function patchAutomationScheduleAssets(extractedDir) {
  const candidates = findWorkspaceRootDropHandlerBundles(extractedDir);
  if (candidates.length === 0) {
    const reason = `Could not find automation schedule bundle in ${path.join(extractedDir, ".vite", "build")} or ${path.join(extractedDir, "webview", "assets")}`;
    console.warn(`WARN: ${reason} — skipping RRULE multi-time patch`);
    return { matched: 0, changed: 0, reason };
  }

  let changed = 0;
  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, "utf8");
    const patched = applyAutomationScheduleMultiTimePatch(source);
    if (patched !== source) {
      fs.writeFileSync(candidate, patched, "utf8");
      changed += 1;
    }
  }

  return { matched: candidates.length, changed };
}

module.exports = {
  applyAutomationScheduleMultiTimePatch,
  patchAutomationScheduleAssets,
};
