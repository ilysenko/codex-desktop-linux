"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  findMatchingBrace,
} = require("../lib/minified-js.js");
const {
  readDirectoryNames,
} = require("../lib/assets.js");

const AUTOMATION_SCHEDULE_MARKER =
  "return t!=null&&n!=null?{hour:t,minute:n}:e.dtstart?{hour:e.dtstart.getHours(),minute:e.dtstart.getMinutes()}:null";
const AUTOMATION_SCHEDULE_PATCH_MARKER = "function codexLinuxNormalizeRruleNumbers(";
const MINIFIED_IDENTIFIER = "[A-Za-z_$][\\w$]*";

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
        return source.includes(AUTOMATION_SCHEDULE_MARKER) ||
          source.includes(AUTOMATION_SCHEDULE_PATCH_MARKER) ||
          (
            /^automation-schedule-.*\.js$/.test(path.basename(candidate)) &&
            source.includes("hasMultipleTimeValues") &&
            source.includes("function Tn(")
          ) ||
          (
            source.includes("hasMultipleTimeValues") &&
            new RegExp(`rruleText:e,time:${MINIFIED_IDENTIFIER}\\(r\\.byhour,r\\.byminute,r\\)`).test(source)
          );
      } catch {
        return false;
      }
    });
}

function findAutomationScheduleHelperBlock(source) {
  const markerIndex = source.indexOf(AUTOMATION_SCHEDULE_MARKER);
  if (markerIndex === -1) {
    return null;
  }

  const start = source.lastIndexOf("var ", markerIndex);
  if (start === -1) {
    return null;
  }

  let cursor = start;
  for (let index = 0; index < 7; index += 1) {
    const functionIndex = source.indexOf("function ", cursor);
    if (functionIndex === -1) {
      return null;
    }
    const openBrace = source.indexOf("{", functionIndex);
    if (openBrace === -1) {
      return null;
    }
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace === -1) {
      return null;
    }
    cursor = closeBrace + 1;
  }

  const text = source.slice(start, cursor);
  const dayMapVar = text.match(/^var ([A-Za-z_$][\w$]*)=\{MO:1,TU:2,WE:3,TH:4,FR:5,SA:6,SU:0\};/)?.[1];
  const functions = [...text.matchAll(/function ([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1]);
  if (dayMapVar == null || functions.length < 7) {
    return null;
  }

  return {
    start,
    end: cursor,
    dayMapVar,
    timeOfDayFn: functions[0],
    singleNumberFn: functions[1],
    dailyFn: functions[2],
    weeklyFn: functions[3],
    weekdaysFn: functions[4],
    weekdayObjectFn: functions[5],
    normalizeWeekdayFn: functions[6],
  };
}

function automationScheduleReplacement(block) {
  return [
    `var ${block.dayMapVar}={MO:1,TU:2,WE:3,TH:4,FR:5,SA:6,SU:0};`,
    `function ${block.timeOfDayFn}(e){let t=codexLinuxNormalizeRruleNumbers(e.byhour,0,23),n=codexLinuxNormalizeRruleNumbers(e.byminute,0,59);return e.dtstart&&(t.length!==0||(t=[e.dtstart.getHours()]),n.length!==0||(n=[e.dtstart.getMinutes()])),t.length!==0&&n.length!==0?{hours:t,minutes:n}:null}`,
    `function ${block.singleNumberFn}(e){let t=codexLinuxNormalizeRruleNumbers(e,-9007199254740991,9007199254740991);return t.length>0?t[0]:null}`,
    "function codexLinuxNormalizeRruleNumbers(e,t,n){let r=Array.isArray(e)?e:[e];return Array.from(new Set(r.filter(e=>typeof e==`number`&&Number.isInteger(e)&&e>=t&&e<=n))).sort((e,t)=>e-t)}",
    "function codexLinuxRruleTimes(e){let t=[];for(let n of e.hours)for(let r of e.minutes)t.push(n*60+r);return Array.from(new Set(t)).sort((e,t)=>e-t)}",
    `function ${block.dailyFn}(e,t){return ${block.weeklyFn}(e,t,[])}`,
    `function ${block.weeklyFn}(e,t,n){let r=new Date(e),i=r.getDay(),a=n.length>0?n:[0,1,2,3,4,5,6],o=codexLinuxRruleTimes(t);if(o.length===0)return e;for(let t=0;t<=7;t+=1){let n=(i+t)%7;if(!a.includes(n))continue;for(let n of o){let i=Math.floor(n/60),a=n%60,s=new Date(r.getFullYear(),r.getMonth(),r.getDate()+t,i,a,0,0);if(s.getTime()>e)return s.getTime()}}return e}`,
    `function ${block.weekdaysFn}(e){return e?(Array.isArray(e)?e:[e]).map(e=>{if(typeof e==\`number\`)return ${block.normalizeWeekdayFn}(e);if(${block.weekdayObjectFn}(e))return ${block.normalizeWeekdayFn}(e.weekday);let t=String(e);return t in ${block.dayMapVar}?${block.dayMapVar}[t]:null}).filter(e=>e!=null):[]}`,
    `function ${block.weekdayObjectFn}(e){return typeof e!=\`object\`||!e||!(\`weekday\`in e)?!1:typeof e.weekday==\`number\`}`,
    `function ${block.normalizeWeekdayFn}(e){return!Number.isInteger(e)||e<0||e>6?null:(e+1)%7}`,
  ].join("");
}

function applyAutomationScheduleMultiTimePatch(source) {
  if (source.includes("function codexLinuxNormalizeRruleNumbers(")) {
    return source;
  }

  const block = findAutomationScheduleHelperBlock(source);
  if (block == null) {
    const currentPatched = applyCurrentAutomationScheduleMultiTimePatch(source);
    if (currentPatched !== source) {
      return currentPatched;
    }
    const genericPatched = applyGenericAutomationScheduleMultiTimePatch(source);
    if (genericPatched !== source) {
      return genericPatched;
    }
    console.warn("WARN: Could not find automation schedule helper block — skipping RRULE multi-time patch");
    return source;
  }

  return source.slice(0, block.start) + automationScheduleReplacement(block) + source.slice(block.end);
}

function applyGenericAutomationScheduleMultiTimePatch(source) {
  if (source.includes("function codexLinuxNormalizeRruleNumbers(")) {
    return source;
  }

  const parserRe = new RegExp(
    `hasMultipleTimeValues:Array\\.isArray\\(r\\.byhour\\)&&r\\.byhour\\.length>1\\|\\|Array\\.isArray\\(r\\.byminute\\)&&r\\.byminute\\.length>1,interval:Math\\.max\\(1,Math\\.round\\(r\\.interval\\?\\?1\\)\\),minute:a,origOptions:n\\.origOptions,rruleText:e,time:(${MINIFIED_IDENTIFIER})\\(r\\.byhour,r\\.byminute,r\\),weekdays:i`,
  );
  const parserMatch = parserRe.exec(source);
  if (!parserMatch) {
    return source;
  }
  const timeFn = parserMatch[1];

  const helperRe = new RegExp(
    "function " +
      timeFn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      `\\(e,t,n\\)\\{let r=(${MINIFIED_IDENTIFIER})\\(e\\),i=\\1\\(t\\);return r!=null&&i!=null\\?(${MINIFIED_IDENTIFIER})\\(r,i\\):n\\.dtstart\\?\\2\\(n\\.dtstart\\.getHours\\(\\),n\\.dtstart\\.getMinutes\\(\\)\\):(${MINIFIED_IDENTIFIER})\\}function \\1\\(e\\)\\{return Array\\.isArray\\(e\\)\\?typeof e\\[0\\]==\`number\`\\?e\\[0\\]:null:typeof e==\`number\`\\?e:null\\}`,
  );
  const helperMatch = helperRe.exec(source);
  if (!helperMatch) {
    return source;
  }
  const helperBlock = helperMatch[0];
  const combineFn = helperMatch[2];

  const summaryRe = new RegExp(
    `function (${MINIFIED_IDENTIFIER})\\(e,t\\)\\{if\\(!e\\|\\|e\\.hasMultipleTimeValues\\)return null;[\\s\\S]*?let i=(${MINIFIED_IDENTIFIER})\\(e\\.time,t\\);return i\\?(${MINIFIED_IDENTIFIER})\\(\\{intl:t,isEveryDay:r,timeLabel:i,weekdays:n\\}\\):null\\}`,
  );
  const summaryMatch = summaryRe.exec(source);
  if (!summaryMatch) {
    return source;
  }
  const summaryBlock = summaryMatch[0];
  const labelFn = summaryMatch[2];

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
    "hasMultipleTimeValues:codexLinuxRruleTimes(r.byhour,r.byminute,r).length>1,interval:Math.max(1,Math.round(r.interval??1)),minute:a,origOptions:n.origOptions,rruleText:e,time:" +
    timeFn +
    "(r.byhour,r.byminute,r),timeValues:codexLinuxRruleTimes(r.byhour,r.byminute,r),weekdays:i";

  const summaryPatch = summaryBlock
    .replace("if(!e||e.hasMultipleTimeValues)return null;", "if(!e)return null;")
    .replace(
      "let i=" + labelFn + "(e.time,t);",
      "let i=codexLinuxAutomationTimeLabel(e,t);",
    );

  let patched = source.replace(helperBlock, () => helperPatch);
  patched = patched.replace(parserMatch[0], () => parserPatch);
  patched = patched.replace(summaryBlock, () => summaryPatch);
  return patched;
}

function applyCurrentAutomationScheduleMultiTimePatch(source) {
  if (
    !source.includes("hasMultipleTimeValues") ||
    !source.includes("function Tn(") ||
    !source.includes("function bn(")
  ) {
    return source;
  }

  let patchedSource = source;
  const helperNeedle =
    "function Tn(e,t,n){let r=En(e),i=En(t);return r!=null&&i!=null?Mn(r,i):n.dtstart?Mn(n.dtstart.getHours(),n.dtstart.getMinutes()):Wt}function En(e){return Array.isArray(e)?typeof e[0]==`number`?e[0]:null:typeof e==`number`?e:null}";
  const helperPatch =
    `${helperNeedle}function codexLinuxNormalizeRruleNumbers(e,t,n){let r=Array.isArray(e)?e:[e];return Array.from(new Set(r.filter(e=>typeof e==\`number\`&&Number.isInteger(e)&&e>=t&&e<=n))).sort((e,t)=>e-t)}function codexLinuxRruleTimes(e,t,n){let r=codexLinuxNormalizeRruleNumbers(e,0,23),i=codexLinuxNormalizeRruleNumbers(t,0,59);n.dtstart&&(r.length!==0||(r=[n.dtstart.getHours()]),i.length!==0||(i=[n.dtstart.getMinutes()]));let a=[];for(let e of r)for(let t of i)a.push(Mn(e,t));return Array.from(new Set(a)).sort()}function codexLinuxAutomationTimeLabel(e,t){let n=Array.isArray(e.timeValues)&&e.timeValues.length>0?e.timeValues:[e.time],r=n.map(e=>Mt(e,t)).filter(Boolean);return r.length===0?null:typeof t.formatList==\`function\`?t.formatList(r,{type:\`conjunction\`}):r.join(\`, \`)}`;
  if (!patchedSource.includes(helperNeedle)) {
    return source;
  }
  patchedSource = patchedSource.replace(helperNeedle, helperPatch);

  const parserNeedle =
    "hasMultipleTimeValues:Array.isArray(r.byhour)&&r.byhour.length>1||Array.isArray(r.byminute)&&r.byminute.length>1,interval:Math.max(1,Math.round(r.interval??1)),minute:a,origOptions:n.origOptions,rruleText:e,time:Tn(r.byhour,r.byminute,r),weekdays:i";
  const parserPatch =
    "hasMultipleTimeValues:codexLinuxRruleTimes(r.byhour,r.byminute,r).length>1,interval:Math.max(1,Math.round(r.interval??1)),minute:a,origOptions:n.origOptions,rruleText:e,time:Tn(r.byhour,r.byminute,r),timeValues:codexLinuxRruleTimes(r.byhour,r.byminute,r),weekdays:i";
  if (!patchedSource.includes(parserNeedle)) {
    return source;
  }
  patchedSource = patchedSource.replace(parserNeedle, parserPatch);

  const summaryNeedle =
    "function bn(e,t){if(!e||e.hasMultipleTimeValues)return null;let n=on(e.weekdays),r=n.length===q.length;if(e.freq===K.MINUTELY)return Sn({intervalMinutes:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq===K.HOURLY)return xn({intervalHours:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq!==K.DAILY&&e.freq!==K.WEEKLY)return null;let i=Mt(e.time,t);return i?wn({intl:t,isEveryDay:r,timeLabel:i,weekdays:n}):null}";
  const summaryPatch =
    "function bn(e,t){if(!e)return null;let n=on(e.weekdays),r=n.length===q.length;if(e.freq===K.MINUTELY)return Sn({intervalMinutes:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq===K.HOURLY)return xn({intervalHours:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq!==K.DAILY&&e.freq!==K.WEEKLY)return null;let i=codexLinuxAutomationTimeLabel(e,t);return i?wn({intl:t,isEveryDay:r,timeLabel:i,weekdays:n}):null}";
  if (!patchedSource.includes(summaryNeedle)) {
    return source;
  }
  patchedSource = patchedSource.replace(summaryNeedle, summaryPatch);
  return patchedSource;
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
