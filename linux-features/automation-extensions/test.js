"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyAutomationScheduleMultiTimePatch,
} = require("../../scripts/patches/impl/automation-schedule.js");
const {
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");

test("automation-extensions is disabled by default and owns both optional patches", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    ["multi-time-rrule", "eager-automation-update"],
  );
  assert.ok(descriptors.every(({ ciPolicy }) => ciPolicy === "optional"));
});

test("automation_update remains eager in the current dynamic tool catalog", () => {
  const source = "const tools=[automation].map(e=>({type:`function`,...e,...E&&(!YBl.has(e.name)||BBl.includes(e.name))?{deferLoading:!0}:{}}));";
  assert.equal(matchesAutomationUpdateEagerToolContract(source), true);
  const patched = applyAutomationUpdateEagerToolPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /e\.name!==`automation_update`&&E&&\(!YBl\.has\(e\.name\)\|\|BBl\.includes\(e\.name\)\)/);
  assert.equal(applyAutomationUpdateEagerToolPatch(patched), patched);
});

function genericScheduleOwnerParts({ time = "$vn", number = "LY", parser = "PY", summary = "qvn" } = {}) {
  return {
    helper: `function ${time}(e,t,n){let r=${number}(e),i=${number}(t);return r!=null&&i!=null?syn(r,i):n.dtstart?syn(n.dtstart.getHours(),n.dtstart.getMinutes()):UY}function ${number}(e){return Array.isArray(e)?typeof e[0]==\`number\`?e[0]:null:typeof e==\`number\`?e:null}`,
    parser: `function ${parser}(e){let i=parse(e),o=minute(i),r=original(e),a=days(i);return{freq:i.freq,hasMultipleTimeValues:Array.isArray(i.byhour)&&i.byhour.length>1||Array.isArray(i.byminute)&&i.byminute.length>1,interval:Math.max(1,Math.round(i.interval??1)),minute:o,origOptions:r.origOptions,rruleText:e,time:${time}(i.byhour,i.byminute,i),weekdays:a}}`,
    summary: `function ${summary}(e,t,n=!0){if(!e||e.hasMultipleTimeValues)return null;let n2=days(e.weekdays),r=n2.length===7;if(e.freq!==\`DAILY\`&&e.freq!==\`WEEKLY\`)return null;let a=uvn(e.time,t);return a?Qvn({intl:t,isEveryDay:r,timeLabel:a,weekdays:n2}):null}`,
    consumer: `function renderSchedule(e,t){return ${summary}(${parser}(e),t)}`,
  };
}

function genericScheduleOwner(options = {}, { helperAfterSummary = false } = {}) {
  const parts = genericScheduleOwnerParts(options);
  return helperAfterSummary
    ? parts.consumer + parts.parser + parts.summary + parts.helper
    : parts.helper + parts.parser + parts.summary + parts.consumer;
}

test("current shared schedule contract accepts hoisted helpers and renamed parser fields", () => {
  const source = genericScheduleOwner({}, { helperAfterSummary: true });
  const patched = applyAutomationScheduleMultiTimePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /timeValues:codexLinuxRruleTimes\(i\.byhour,i\.byminute,i\)/u);
  assert.match(patched, /function qvn\(e,t,n=!0\)\{if\(!e\)return null/u);
});

test("generalized schedule matcher rejects duplicate, mixed, partial, and incoherent owners", () => {
  const firstParts = genericScheduleOwnerParts();
  const secondParts = genericScheduleOwnerParts({
    time: "Avn",
    number: "BY",
    parser: "CY",
    summary: "Dvn",
  });
  const first = genericScheduleOwner();
  const second = genericScheduleOwner({ time: "Avn", number: "BY", parser: "CY", summary: "Dvn" });
  const patched = applyAutomationScheduleMultiTimePatch(first);
  const cases = [
    first + second,
    patched + second,
    firstParts.parser,
    firstParts.parser + secondParts.helper + secondParts.summary + secondParts.consumer,
    firstParts.helper + firstParts.parser + secondParts.summary + secondParts.consumer,
    firstParts.helper + firstParts.parser + firstParts.summary,
    first + firstParts.consumer,
  ];
  for (const source of cases) {
    assert.equal(applyAutomationScheduleMultiTimePatch(source), source);
  }
});
