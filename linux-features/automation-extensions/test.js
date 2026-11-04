"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  AUTOMATION_SCHEDULE_ASSET_NEEDLES,
  applyAutomationScheduleMultiTimePatch,
  matchesAutomationScheduleContract,
} = require("../../scripts/patches/impl/automation-schedule.js");
const {
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");

// Rspack/SWC chunk shape: module factories inside `__webpack_modules__`.
const chunk = (...modules) =>
  "export const __rspack_esm_id=24191;export const __rspack_esm_ids=[24191];" +
  `export const __webpack_modules__={${modules.join(",")}};`;

function loadChunkModules(source, globals) {
  const start = source.indexOf("__webpack_modules__=") + "__webpack_modules__=".length;
  const names = Object.keys(globals);
  return new Function(...names, `return ${source.slice(start, source.lastIndexOf(";"))}`)(
    ...names.map((name) => globals[name]),
  );
}

test("automation-extensions is disabled by default and owns both optional content-located patches", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    ["multi-time-rrule", "eager-automation-update"],
  );
  assert.ok(descriptors.every(({ ciPolicy }) => ciPolicy === "optional"));
  assert.ok(descriptors.every(({ phase }) => phase === "webview-asset"));
  assert.ok(descriptors.every(({ assetNeedles, pattern, assetPattern }) =>
    assetNeedles.length > 0 && pattern == null && assetPattern == null));
});

const DYNAMIC_TOOLS =
  'mjAH(e,t,n){var r=n("x1"),i="codex_app";function a({tools:e,eagerToolNames:t,deferredToolNames:n,supportsDynamicToolNamespaces:s,additionalNamespaces:o}){let l=e.map(e=>({type:"function",...e,...s&&(!t.has(e.name)||n.includes(e.name))?{deferLoading:!0}:{}}));return s?[{type:"namespace",name:i,description:r.l2,tools:l},...o]:l}n.d(t,{Nz:()=>a})}';

test("automation_update remains eager in the current dynamic tool catalog", () => {
  const source = chunk(DYNAMIC_TOOLS);
  assert.equal(matchesAutomationUpdateEagerToolContract(source), true);
  const patched = applyAutomationUpdateEagerToolPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /e\.name!=="automation_update"&&s&&\(!t\.has\(e\.name\)\|\|n\.includes\(e\.name\)\)/);
  assert.equal(matchesAutomationUpdateEagerToolContract(patched), true);
  assert.equal(applyAutomationUpdateEagerToolPatch(patched), patched);

  const exports = {};
  loadChunkModules(patched, {}).mjAH({}, exports, Object.assign(() => ({ l2: "tools" }), {
    d: (target, getters) => Object.entries(getters).forEach(([key, get]) => Object.defineProperty(target, key, { get })),
  }));
  const tools = exports.Nz({
    tools: [{ name: "automation_update" }, { name: "other" }],
    eagerToolNames: new Set(),
    deferredToolNames: [],
    supportsDynamicToolNamespaces: true,
    additionalNamespaces: [],
  })[0].tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.deferLoading ?? false]), [
    ["automation_update", false],
    ["other", true],
  ]);
});

test("duplicate or changed dynamic tool catalogs are left unchanged", () => {
  for (const source of [
    chunk(DYNAMIC_TOOLS, DYNAMIC_TOOLS.replace("mjAH", "mjAI")),
    chunk(DYNAMIC_TOOLS.replace('type:"function"', "type:`function`")),
  ]) {
    assert.equal(matchesAutomationUpdateEagerToolContract(source), false);
    assert.equal(applyAutomationUpdateEagerToolPatch(source), source);
  }
});

function scheduleModule({ id = "qKlE", parser = "W", summary = "Q", combine = "es", number = "ee" } = {}) {
  return `${id}(e,t,n){var o=n("rr"),u=n("ut");` +
    `function ${number}(e){return Array.isArray(e)?"number"==typeof e[0]?e[0]:null:"number"==typeof e?e:null}` +
    `function ${combine}(e,t){return String(e).padStart(2,"0")+":"+String(t).padStart(2,"0")}` +
    `function ${parser}(e){if(!e)return null;try{var t,n,r;let i,a,l=(0,o.YI)(e),c=l.rrules()[0];if(!c)return null;let p=c.options,f=days(p),m=${number}(p.byminute);` +
    "return{freq:p.freq,isSingleRecurrence:1===l.rrules().length,hasMultipleTimeValues:Array.isArray(p.byhour)&&p.byhour.length>1||Array.isArray(p.byminute)&&p.byminute.length>1,interval:Math.max(1,Math.round(p.interval??1)),minute:m,origOptions:c.origOptions,rruleText:e," +
    `time:(t=p.byhour,n=p.byminute,r=p,i=${number}(t),a=${number}(n),null!=i&&null!=a?${combine}(i,a):r.dtstart?${combine}(r.dtstart.getHours(),r.dtstart.getMinutes()):h),weekdays:f}}catch{return null}}` +
    `function ${summary}(e,t){if(!e||e.hasMultipleTimeValues)return null;let n=L(e.weekdays),r=7===n.length;if(e.freq!==o.p3.DAILY&&e.freq!==o.p3.WEEKLY)return null;let i=(0,u.mm)(e.time,t);return i?function({intl:e,timeLabel:n}){return e.formatMessage({id:"settings.automations.scheduleSummary.daily",defaultMessage:"Daily at {time}"},{time:n})}({intl:t,isEveryDay:r,timeLabel:i,weekdays:n}):null}` +
    `function render(e,t){return ${summary}(${parser}(N(e)),t)??null}n.d(t,{render:()=>render})` +
    "}";
}

function renderSchedule(source, options) {
  const modules = loadChunkModules(source, { days: () => [], L: (value) => value, N: (value) => value, h: "00:00" });
  const exports = {};
  const rrule = { p3: { DAILY: 3, WEEKLY: 2 }, YI: () => ({ rrules: () => [{ options, origOptions: options }] }) };
  const labels = { mm: (time) => `[${time}]` };
  const require = Object.assign((id) => (id === "rr" ? rrule : labels), {
    d: (target, getters) => Object.entries(getters).forEach(([key, get]) => Object.defineProperty(target, key, { get })),
  });
  modules.qKlE({}, exports, require);
  const intl = {
    formatMessage: (_message, { time }) => `Daily at ${time}`,
    formatList: (items) => items.join(" and "),
  };
  return exports.render("RRULE:FREQ=DAILY", intl);
}

test("current schedule owner gains multi-time parsing and summary labels inside its module", () => {
  // Another module reuses the same minified names; only the owner changes.
  const unrelated = "odKs(e,t,n){function W(e){return e}function Q(e,t){return t}}";
  const source = chunk(unrelated, scheduleModule());
  assert.equal(matchesAutomationScheduleContract(source), true);
  const patched = applyAutomationScheduleMultiTimePatch(source);
  assert.notEqual(patched, source);
  assert.ok(patched.includes(unrelated));
  assert.match(patched, /hasMultipleTimeValues:codexLinuxRruleTimes\(p\.byhour,p\.byminute,p,es\)\.length>1,/u);
  assert.match(patched, /timeValues:codexLinuxRruleTimes\(p\.byhour,p\.byminute,p,es\),weekdays:f\}/u);
  assert.match(patched, /function Q\(e,t\)\{if\(!e\)return null;/u);
  assert.match(patched, /let i=codexLinuxAutomationTimeLabel\(e,t,\(e,t\)=>\(0,u\.mm\)\(e,t\)\);return i\?/u);
  assert.equal(matchesAutomationScheduleContract(patched), true);
  assert.equal(applyAutomationScheduleMultiTimePatch(patched), patched);

  const multi = { freq: 3, byhour: [17, 9], byminute: [0] };
  assert.equal(renderSchedule(source, multi), null);
  assert.equal(renderSchedule(patched, multi), "Daily at [09:00] and [17:00]");
  assert.equal(renderSchedule(patched, { freq: 3, byhour: [8], byminute: [30] }), "Daily at [08:30]");
});

test("schedule matcher rejects duplicate, partial, and incoherent owners", () => {
  const owner = scheduleModule();
  const cases = [
    chunk(owner, scheduleModule({ id: "aaaa", parser: "P", summary: "S" })),
    chunk(owner.replace("time:(t=p.byhour", "time:(t=p.byhours")),
    chunk(owner.replace("function render(e,t){return Q(W(N(e)),t)??null}", "")),
    chunk(owner.replace("if(!e||e.hasMultipleTimeValues)return null;", "if(!e)return null;")),
    chunk(owner.replace("let i=(0,u.mm)(e.time,t);", "let i=(0,u.mm)(e.dtstart,t);")),
    chunk(owner.replace("function render(", "function Q(e,t){if(!e||e.hasMultipleTimeValues)return null;return t}function render(")),
  ];
  for (const source of cases) {
    assert.equal(matchesAutomationScheduleContract(source), false);
    assert.equal(applyAutomationScheduleMultiTimePatch(source), source);
  }
  const patched = applyAutomationScheduleMultiTimePatch(chunk(owner));
  const partial = patched.replace("timeValues:codexLinuxRruleTimes(", "timeValues:changed(");
  assert.equal(applyAutomationScheduleMultiTimePatch(partial), partial);
});

test("signed official webview has one schedule owner and one dynamic tool catalog", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP ? false : "CODEX_SIGNED_EXTRACTED_APP is not set",
}, () => {
  const appDir = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const read = (assetName) => fs.readFileSync(path.join(appDir, "webview", "assets", assetName), "utf8");
  const [schedule, eager] = descriptors;
  const scheduleOwners = findWebviewAssetsContaining(appDir, AUTOMATION_SCHEDULE_ASSET_NEEDLES)
    .filter((assetName) => schedule.assetMatch(read(assetName)));
  assert.equal(scheduleOwners.length, 1);
  const source = read(scheduleOwners[0]);
  const patched = schedule.apply(source);
  assert.notEqual(patched, source);
  assert.equal(schedule.apply(patched), patched);

  const catalogs = findWebviewAssetsContaining(appDir, eager.assetNeedles)
    .filter((assetName) => eager.assetMatch(read(assetName)));
  assert.equal(catalogs.length, 1);
  assert.match(eager.apply(read(catalogs[0])), /\.name!=="automation_update"&&/u);
});
