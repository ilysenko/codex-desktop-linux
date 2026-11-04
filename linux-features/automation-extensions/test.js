"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const vm = require("node:vm");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  AUTOMATION_SCHEDULE_ASSET_NEEDLES,
  automationScheduleState,
  applyAutomationScheduleMultiTimePatch,
  matchesAutomationScheduleContract,
} = require("./multi-time-rrule.js");
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
  assert.deepEqual(descriptors.map(({ phase }) => phase), ["extracted-app:pre-webview", "webview-asset"]);
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
  const patched = applyAutomationScheduleMultiTimePatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyAutomationScheduleMultiTimePatch(patched), patched);

  const catalogs = findWebviewAssetsContaining(appDir, eager.assetNeedles)
    .filter((assetName) => eager.assetMatch(read(assetName)));
  assert.equal(catalogs.length, 1);
  assert.match(eager.apply(read(catalogs[0])), /\.name!=="automation_update"&&/u);
});


const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { rspackModuleFactories, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");

function workspace(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "automation-schedule-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

function runScheduleDescriptor(root) {
  const report = createPatchReport();
  captureWarnings(() => applyExtractedAppPatchDescriptors(root, [descriptors[0]], {}, report, "extracted-app:pre-webview"));
  return report.patches[0];
}

function moveHelperIntoUnusedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const open = source.indexOf("{", start), end = findMatchingBrace(source, open) + 1;
  return source.slice(0, start) + source.slice(end) + `function unused(){${source.slice(start, end)}}`;
}

test("the full generated schedule state proves inclusive 23-hour and 59-minute boundaries", () => {
  const patched = applyAutomationScheduleMultiTimePatch(chunk(scheduleModule()));
  const damaged = patched.replace("e>=t&&e<=n", "e>=t&&e<n");
  assert.equal(renderSchedule(patched, { freq: 3, byhour: [0, 23], byminute: [0, 59] }),
    "Daily at [00:00] and [00:59] and [23:00] and [23:59]");
  assert.equal(renderSchedule(damaged, { freq: 3, byhour: [0, 23], byminute: [0, 59] }), "Daily at [00:00]");
  assert.equal(automationScheduleState(patched), "patched");
  assert.equal(automationScheduleState(damaged), "invalid");
  const rejected = captureWarnings(() => applyAutomationScheduleMultiTimePatch(damaged));
  assert.equal(rejected.value, damaged);
  assert.equal(rejected.warnings.length, 1);
});

test("canonical schedule verification rejects changed helpers, bindings, scopes and orphan calls", () => {
  const pristine = chunk(scheduleModule()), patched = applyAutomationScheduleMultiTimePatch(pristine);
  const invalid = [
    patched.replace("e>=t&&e<=n", "e>=t&&e<n"),
    patched.replace("codexLinuxNormalizeRruleNumbers(e,0,23)", "codexLinuxNormalizeRruleNumbers(e,0,22)"),
    patched.replace("codexLinuxNormalizeRruleNumbers(t,0,59)", "codexLinuxNormalizeRruleNumbers(t,0,58)"),
    patched.replace("Array.isArray(e.timeValues)", "Array.isArray(e.wrongTimes)"),
    patched.replace("timeValues:codexLinuxRruleTimes(p.byhour,p.byminute,p,es)", "timeValues:codexLinuxRruleTimes(p.byhour,p.byminute,p,wrong)"),
    patched.replace("codexLinuxAutomationTimeLabel(e,t,(e,t)=>(0,u.mm)(e,t))", "codexLinuxAutomationTimeLabel(e,t,(e,t)=>(0,u.mm)(t,e))"),
    moveHelperIntoUnusedFunction(patched, "codexLinuxRruleTimes"),
    patched + ";codexLinuxRruleTimes([],[],{},String)",
    pristine + "function codexLinuxRruleTimes(){return[]}",
  ];
  for (const source of invalid) {
    assert.equal(javascriptSourceParses(source), true);
    assert.equal(matchesAutomationScheduleContract(source), false);
    const result = captureWarnings(() => applyAutomationScheduleMultiTimePatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
  }
});

test("schedule owner text in strings, templates and comments never proves executable ownership", () => {
  const body = scheduleModule().slice(scheduleModule().indexOf("{") + 1, -1);
  for (const source of [
    chunk(`owner(e,t,n){const text=${JSON.stringify(body)}}`),
    chunk("owner(e,t,n){const text=`" + body + "`}"),
    chunk("owner(e,t,n){/*" + body + "*/}"),
  ]) {
    assert.equal(javascriptSourceParses(source), true);
    assert.equal(automationScheduleState(source), "invalid");
    const result = captureWarnings(() => applyAutomationScheduleMultiTimePatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
  }
});

test("production schedule descriptor updates all same-ID copies once without changing unrelated modules", (t) => {
  const unrelated = 'other(e,t,n){const value="unchanged"}';
  const original = chunk(scheduleModule(), unrelated);
  const files = { "async/first.js": original, "nested/second.js": original };
  const root = workspace(t, files);
  for (const expected of ["applied", "already-applied"]) assert.equal(runScheduleDescriptor(root).status, expected);
  for (const name of Object.keys(files)) {
    const output = fs.readFileSync(path.join(root, "webview/assets", name), "utf8");
    assert.equal(output, applyAutomationScheduleMultiTimePatch(original));
    assert.ok(output.includes(unrelated));
    assert.equal(javascriptSourceParses(output), true);
  }
});

for (const scenario of ["missing", "different-identities", "marker-free-replica", "partial-replica", "mixed-replicas", "invalid-boundary"]) {
  test(`production schedule descriptor rejects ${scenario} without writing`, (t) => {
    const original = chunk(scheduleModule()), patched = applyAutomationScheduleMultiTimePatch(original);
    let files;
    if (scenario === "missing") files = { "one.js": chunk('other(e){return false}') };
    else if (scenario === "invalid-boundary") files = { "one.js": patched.replace("e>=t&&e<=n", "e>=t&&e<n") };
    else files = {
      "one.js": original,
      "nested/two.js": scenario === "different-identities" ? chunk(scheduleModule({ id: "different" })) :
        scenario === "marker-free-replica" ? chunk('qKlE(e,t,n){return false}') :
        scenario === "partial-replica" ? patched.replace("e>=t&&e<=n", "e>=t&&e<n") : patched,
    };
    const root = workspace(t, files);
    assert.equal(runScheduleDescriptor(root).status, "skipped-optional");
    for (const [name, expected] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(root, "webview/assets", name), "utf8"), expected);
    }
  });
}

function signedScheduleSource(app) {
  const names = findWebviewAssetsContaining(app, AUTOMATION_SCHEDULE_ASSET_NEEDLES)
    .filter((name) => matchesAutomationScheduleContract(fs.readFileSync(path.join(app, "webview/assets", name), "utf8")));
  assert.equal(names.length, 1);
  return { name: names[0], source: fs.readFileSync(path.join(app, "webview/assets", names[0]), "utf8") };
}

// Execute the actual native editor, serializer, validator, RRULE parser and
// time-label module. Unrelated analytics/date imports and draft state atoms
// are stubbed; native scheduling and save-payload functions execute unchanged.
// Resolve module imports from the factory's own static require binding.
function nativeSchedule(app, source) {
  const snapshots = [...rspackModuleFactories(source, "signed-schedule.js")];
  const owners = snapshots.filter(({ moduleSource }) => moduleSource.includes("hasMultipleTimeValues:") && moduleSource.includes("customRrule:") && moduleSource.includes("scheduleSummary.daily"));
  assert.equal(owners.length, 1);
  const [owner] = owners;
  const ruleAlias = /new ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\{freq:\1\.\2\.MINUTELY/u.exec(owner.moduleSource)?.[1];
  const labelAlias = /let [A-Za-z_$][\w$]*=\(0,([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\)\(e\.time,t\);return/u.exec(owner.moduleSource)?.[1] ??
    /codexLinuxAutomationTimeLabel\(e,t,\(e,t\)=>\(0,([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\)\(e,t\)\)/u.exec(owner.moduleSource)?.[1];
  assert.ok(ruleAlias && labelAlias);
  const ruleBinding = findRspackRequireBinding(owner, ruleAlias), labelBinding = findRspackRequireBinding(owner, labelAlias);
  assert.ok(ruleBinding && labelBinding);
  const registry = loadChunkModules(source, {}), loaded = new Map();
  function factory(id) {
    if (registry[id]) return registry[id];
    const copies = findWebviewAssetsContaining(app, [`${id}(`]).flatMap((name) => {
      const text = fs.readFileSync(path.join(app, "webview/assets", name), "utf8");
      const modules = loadChunkModules(text, {});
      return modules[id] ? [modules[id]] : [];
    });
    assert.ok(copies.length > 0, `actual RRULE dependency ${id}`);
    return copies[0];
  }
  function requireModule(id) {
    if (loaded.has(id)) return loaded.get(id);
    const target = {};
    loaded.set(id, target);
    factory(id)({}, target, requireModule);
    return target;
  }
  function exportsInto(target, getters, values = {}) {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { enumerable: true, get });
    Object.assign(target, values);
  }
  requireModule.d = exportsInto;
  requireModule.r = () => {};
  const rules = requireModule(ruleBinding.moduleId), labels = requireModule(labelBinding.moduleId);
  const nativeRequire = (id) => id === ruleBinding.moduleId ? rules : id === labelBinding.moduleId ? labels : {};
  nativeRequire.d = exportsInto;
  const native = {};
  registry[owner.moduleId]({}, native, nativeRequire);
  function exported(predicate) {
    const values = Object.values(native).filter((value) => typeof value === "function" && predicate(value.toString()));
    assert.equal(values.length, 1);
    return values[0];
  }
  const draftOwners = snapshots.filter(({ moduleSource }) =>
    moduleSource.includes("rawRrule") && moduleSource.includes("scheduleDirty") &&
    moduleSource.includes("Cron automation draft is incomplete"));
  assert.equal(draftOwners.length, 1);
  const drafts = {};
  const draftRequire = (id) => id === owner.moduleId ? native : {
    DIv: (value) => value, m20: "fixture-project", vP: () => null,
  };
  draftRequire.d = exportsInto;
  draftRequire.n = () => () => () => false;
  registry[draftOwners[0].moduleId]({}, drafts, draftRequire);
  const draftFunctions = Object.values(drafts).filter((value) => typeof value === "function");
  const draftRrules = draftFunctions.filter((value) => value.toString().includes("!e.scheduleDirty&&e.rawRrule?e.rawRrule:"));
  const savePayloads = draftFunctions.filter((value) => value.toString().includes('throw Error("Automation draft is incomplete")'));
  assert.equal(draftRrules.length, 1);
  assert.equal(savePayloads.length, 1);
  const intl = {
    formatTime: (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    formatList: (values) => values.join(" and "),
    formatMessage: ({ defaultMessage }, values = {}) => defaultMessage.replace(/\{([^{}]+)\}/g, (_, name) => String(values[name])),
  };
  return {
    read: exported((text) => text.includes('"exact_schedule"') && text.includes("customRrule:")),
    serialize: exported((text) => text.includes('case"custom":return e.customRrule.trim()')),
    valid: exported((text) => text.includes("Number.isNaN(Date.parse") && text.includes("customRrule.trim()")),
    switchMode: exported((text) => text.includes('mode:"custom"') && text.includes('"custom"===')),
    summary: exported((text) => text.includes("inbox.automations.cloud.monthlySchedule")),
    draftRrule: draftRrules[0],
    savePayload: savePayloads[0],
    intl,
  };
}

test("signed production schedule descriptor applies twice and rejects the actual 23-hour regression", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, (t) => {
  const { name, source } = signedScheduleSource(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const root = workspace(t, { [name]: source });
  assert.equal(runScheduleDescriptor(root).status, "applied");
  assert.equal(runScheduleDescriptor(root).status, "already-applied");
  const target = path.join(root, "webview/assets", name), patched = fs.readFileSync(target, "utf8");
  assert.equal(patched, applyAutomationScheduleMultiTimePatch(source));
  assert.equal(javascriptSourceParses(patched), true);
  const damaged = patched.replace("e>=t&&e<=n", "e>=t&&e<n");
  fs.writeFileSync(target, damaged);
  assert.equal(runScheduleDescriptor(root).status, "skipped-optional");
  assert.equal(fs.readFileSync(target, "utf8"), damaged);
});

test("signed native editor saves multi-time daily/weekly schedules with timezone/date text intact", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP, { source } = signedScheduleSource(app);
  const original = nativeSchedule(app, source), patched = nativeSchedule(app, applyAutomationScheduleMultiTimePatch(source));
  for (const rule of [
    "FREQ=DAILY;BYHOUR=0,23;BYMINUTE=0,59",
    "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9,23;BYMINUTE=30",
    "DTSTART;TZID=Asia/Shanghai:20261105T090000\nRRULE:FREQ=DAILY;BYHOUR=9,23;BYMINUTE=0;UNTIL=20261231T155959Z",
  ]) {
    const before = original.read(rule), editor = patched.read(rule);
    assert.equal(before.mode, "custom");
    assert.equal(editor.mode, "custom");
    assert.equal(editor.customRrule, rule);
    assert.equal(patched.valid(editor), true);
    assert.equal(patched.serialize(editor), original.serialize(before));
    assert.equal(patched.serialize(editor), rule);
    assert.equal(patched.serialize(patched.read(patched.serialize(editor))), rule);
  }
  const existing = "FREQ=DAILY;BYHOUR=0,23;BYMINUTE=0,59";
  const edited = existing.replace("BYHOUR=0,23", "BYHOUR=9,23");
  const draft = {
    id: "Automation_0123456789abcdef0123456789abcdef", kind: "cron", name: "Multiple times", prompt: "Run task",
    executionEnvironment: "local", model: "fixture-model", rawRrule: existing,
    scheduleConfig: patched.read(existing), scheduleDirty: false,
  };
  assert.equal(patched.draftRrule(draft), existing);
  const changed = { ...draft, scheduleDirty: true, scheduleConfig: { ...draft.scheduleConfig, customRrule: edited } };
  assert.equal(patched.valid(changed.scheduleConfig), true);
  const saved = patched.savePayload({ draft: changed, name: changed.name, prompt: changed.prompt,
    status: "ACTIVE", rrule: patched.draftRrule(changed) });
  assert.equal(saved.rrule, edited);
  assert.equal(saved.kind, "cron");
  assert.equal(patched.serialize(patched.read(saved.rrule)), edited);
  const multi = patched.read("FREQ=DAILY;BYHOUR=0,23;BYMINUTE=0,59");
  assert.equal(original.summary(multi, original.intl), null);
  assert.equal(patched.summary(multi, patched.intl), "Daily at 00:00 and 00:59 and 23:00 and 23:59");
});

test("signed native single-time editing and existing invalid-input/date validation remain unchanged", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP, { source } = signedScheduleSource(app);
  const before = nativeSchedule(app, source), after = nativeSchedule(app, applyAutomationScheduleMultiTimePatch(source));
  const rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=30", a = before.read(rule), b = after.read(rule);
  assert.equal(a.mode, "daily");
  assert.deepEqual(b, a);
  assert.equal(after.valid(b), true);
  const changed = { ...b, time: "23:59" };
  assert.equal(after.serialize(changed), before.serialize({ ...a, time: "23:59" }));
  const custom = after.switchMode(b, "custom");
  assert.equal(after.serialize(custom), before.serialize(before.switchMode(a, "custom")));
  for (const input of ["", "NOT_A_RRULE", "FREQ=INVALID"]) {
    const state = { ...b, mode: "custom", customRrule: input };
    assert.equal(after.valid(state), before.valid(state));
    assert.equal(after.valid(state), false);
  }
  // The native custom-rule validator accepts this parser-tolerated value.
  // Preserve that existing convention instead of inventing a stricter editor.
  const tolerated = { ...b, mode: "custom", customRrule: "FREQ=DAILY;BYHOUR=bad" };
  assert.equal(before.valid(tolerated), true);
  assert.equal(after.valid(tolerated), before.valid(tolerated));
  for (const field of ["oneTimeDate", "untilDate"]) {
    const state = { ...b, [field]: "invalid-date" };
    assert.equal(after.valid(state), false);
    assert.equal(after.valid(state), before.valid(state));
  }
});
