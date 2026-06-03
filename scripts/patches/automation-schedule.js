"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  findMatchingBrace,
  readDirectoryNames,
} = require("./shared.js");

const AUTOMATION_SCHEDULE_MARKER =
  "return t!=null&&n!=null?{hour:t,minute:n}:e.dtstart?{hour:e.dtstart.getHours(),minute:e.dtstart.getMinutes()}:null";
const AUTOMATION_SCHEDULE_PATCH_MARKER = "function codexLinuxNormalizeRruleNumbers(";

function findWorkspaceRootDropHandlerBundles(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  return readDirectoryNames(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(buildDir, name))
    .filter((candidate) => {
      try {
        const source = fs.readFileSync(candidate, "utf8");
        return source.includes(AUTOMATION_SCHEDULE_MARKER) ||
          source.includes(AUTOMATION_SCHEDULE_PATCH_MARKER);
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
    console.warn("WARN: Could not find automation schedule helper block — skipping RRULE multi-time patch");
    return source;
  }

  return source.slice(0, block.start) + automationScheduleReplacement(block) + source.slice(block.end);
}

function patchAutomationScheduleAssets(extractedDir) {
  const candidates = findWorkspaceRootDropHandlerBundles(extractedDir);
  if (candidates.length === 0) {
    const reason = `Could not find workspace-root-drop-handler bundle in ${path.join(extractedDir, ".vite", "build")}`;
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
