"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");
const { findMainProcessChunks, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");

const CHRONICLE_MODULE_EXPRESSIONS = Object.freeze({
  childProcessVar: 'require("node:child_process")',
  fsVar: 'require("node:fs")',
  pathVar: 'require("node:path")',
});
const IDENTIFIER = "[A-Za-z_$][\\w$]*";
// Since 26.1029 the desktop main process no longer serves `vscode://codex/<method>`
// webview fetches from a handler map: the fetch wrapper's `handleRequest` keeps
// only the dictation route and throws for everything else. The Linux bridge
// handlers live in one module-scope object and are routed from that request
// entry point; replies use the same inline view-message sender as dictation.
// Other Linux routes (read-aloud) may already sit in front of the dictation
// route, so the entry tolerates `/*codex-linux-<id>-route*/` prefixes.
const FETCH_ROUTE_MARKER = "/*codex-linux-chronicle-skysight-route*/";
const BRIDGE_HANDLERS_NAME = "codexLinuxChronicleBridgeHandlers";
const BRIDGE_HANDLERS_END_MARKER = "/*codex-linux-chronicle-bridge-handlers-end*/";
function fetchRouteSource(site) {
  let reply = "codexLinuxChronicleMessage";
  while (reply === site.webContentsVar || reply === site.requestVar) reply += "_";
  return `${FETCH_ROUTE_MARKER}if(codexLinuxChronicleFetchHandler(${site.requestVar}?.url))return void await codexLinuxChronicleFetch(${site.requestVar},${reply}=>${site.senderExpr}(${site.webContentsVar},${reply}));`;
}

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function chronicleSkysightBridgeSource() {
  return [
    `"chronicle-permissions":async()=>{let e=await codexLinuxChronicleSidecarControlStateAsync(),t=e.enabled===!0?"granted":"unknown";return{accessibility:t,screenRecording:t,chronicleSidecarPresent:e.enabled===!0,chronicleSidecarProcessState:e.state??"disabled",chronicleOcrAvailable:e.chronicleOcrAvailable===!0,chronicleOcrStatus:e.chronicleOcrStatus??"unknown",chronicleOcrBackend:e.chronicleOcrBackend??null,chronicleOcrLanguage:e.chronicleOcrLanguage??null}}`,
    `"getChronicleSidecarControlState":async()=>codexLinuxChronicleSidecarControlStateAsync()`,
    `"toggleChronicleSidecar":async()=>codexLinuxChronicleToggleSidecar()`,
    `"linux-record-replay-skysight-start":async({intervalSeconds:e,summaryAgent:t,source:r,owner:a}={})=>{let n=["skysight","start"];e&&n.push("--interval-seconds",String(e));r&&n.push("--source",String(r));a&&n.push("--owner",String(a));t===!0&&n.push("--summary-agent","enabled");t===!1&&n.push("--summary-agent","disabled");return codexLinuxRecordReplayRun(n,15000)}`,
    `"linux-record-replay-skysight-status":async()=>codexLinuxRecordReplayRun(["skysight","status"],5000)`,
    `"linux-record-replay-skysight-pause":async()=>codexLinuxRecordReplayRun(["skysight","pause"],10000)`,
    `"linux-record-replay-skysight-resume":async()=>codexLinuxRecordReplayRun(["skysight","resume"],10000)`,
    `"linux-record-replay-skysight-stop":async()=>codexLinuxRecordReplayRun(["skysight","stop"],10000)`,
    `"linux-record-replay-skysight-snapshot":async({source:e}={})=>{let t=["skysight","snapshot"];e&&t.push("--source",String(e));return codexLinuxRecordReplayRun(t,15000)}`,
    `"linux-record-replay-skysight-list-exclusions":async()=>codexLinuxRecordReplayRun(["skysight","list-exclusions"],5000)`,
    `"linux-record-replay-skysight-update-exclusion":async({kind:e,value:t,reason:n,remove:r}={})=>{let a=codexLinuxRecordReplayString(e),o=codexLinuxRecordReplayString(t);if(!a||!o)return{ok:!1,action:"skysight.update-exclusion",message:"kind and value are required"};let s=["skysight","update-exclusion","--kind",a,"--value",o];n&&s.push("--reason",String(n));r&&s.push("--remove");return codexLinuxRecordReplayRun(s,10000)}`,
  ].join(",");
}

// Module-scope handler registry. record-and-replay registers its own handlers
// directly after BRIDGE_HANDLERS_END_MARKER, so keep the marker last.
function chronicleSkysightBridgeHandlersSource() {
  return `const ${BRIDGE_HANDLERS_NAME}={${chronicleSkysightBridgeSource()}};${BRIDGE_HANDLERS_END_MARKER}`;
}

function chronicleSkysightFetchHelperSource() {
  return `function codexLinuxChronicleFetchHandler(e){if(typeof e!=="string"||!e.startsWith("vscode://codex/"))return null;let t=e.slice(15);return Object.prototype.hasOwnProperty.call(${BRIDGE_HANDLERS_NAME},t)&&typeof ${BRIDGE_HANDLERS_NAME}[t]==="function"?${BRIDGE_HANDLERS_NAME}[t]:null}
async function codexLinuxChronicleFetch(e,t){let n=e?.requestId;try{let r=codexLinuxChronicleFetchHandler(e?.url);if(!r)throw Error("Unsupported Linux bridge method");let a;try{a=typeof e?.body==="string"?e.body.length>0?JSON.parse(e.body):{}:e?.body??{}}catch{throw Error("Invalid Linux bridge request")}if(a==null||typeof a!=="object"||Array.isArray(a))throw Error("Invalid Linux bridge parameters");let o=await r(a);t({type:"fetch-response",responseType:"success",requestId:n,status:200,headers:{"content-type":"application/json"},bodyJsonString:JSON.stringify(o??null)})}catch(r){t({type:"fetch-response",responseType:"error",requestId:n,status:500,error:r instanceof Error?r.message:String(r)})}}`;
}

function recordReplayRuntimeHelperSource({ childProcessVar, fsVar, pathVar }) {
  return `function codexLinuxRecordReplayString(e){return typeof e==="string"&&e.trim().length>0?e.trim():null}
function codexLinuxRecordReplayBin(){let e=codexLinuxRecordReplayString(process.env.CODEX_RECORD_REPLAY_LINUX_BIN);if(e)return e;let t=[];try{process.resourcesPath&&t.push(${pathVar}.join(process.resourcesPath,"native","codex-record-replay-linux"))}catch{}try{t.push(${pathVar}.join(process.cwd(),"resources","native","codex-record-replay-linux"))}catch{}try{let e=process.env.PATH||"";for(let n of e.split(${pathVar}.delimiter))n&&t.push(${pathVar}.join(n,"codex-record-replay-linux"))}catch{}t.push("codex-record-replay-linux");for(let e of t){try{if(e==="codex-record-replay-linux"||${fsVar}.existsSync(e))return e}catch{}}return "codex-record-replay-linux"}
function codexLinuxRecordReplayParse(e){let t=String(e||"").trim();if(!t)return null;try{return JSON.parse(t)}catch{return{raw:t}}}
function codexLinuxRecordReplayRun(e,t){let n=codexLinuxRecordReplayBin();return new Promise(r=>{${childProcessVar}.execFile(n,e,{encoding:"utf8",timeout:t,maxBuffer:16777216},(t,a,o)=>{let s=codexLinuxRecordReplayParse(a);if(t)return r({ok:!1,command:n,args:e,message:t instanceof Error?t.message:String(t),code:t?.code??null,stdout:a||"",stderr:o||"",json:s});r({ok:!0,command:n,args:e,stdout:a||"",stderr:o||"",json:s})})})}
${chronicleSkysightHelperSource()}`;
}

function chronicleSkysightHelperSource() {
  return `function codexLinuxChronicleStatusPayload(e){let t=e?.json;return e?.ok===!0&&t!=null&&typeof t==="object"&&!Array.isArray(t)&&t.ok===!0&&["running","paused","stopped"].includes(t.state)&&typeof t.is_running==="boolean"?t:null}\nfunction codexLinuxChronicleUpstreamStatus(e){let t=codexLinuxChronicleStatusPayload(e);if(t==null)throw Error(e?.message||e?.stderr||e?.json?.error||"Invalid Linux Skysight status");let n=String(t.state||""),r=t.paused===!0||t.is_paused===!0||t.isPaused===!0||n==="paused",a=t.is_running===!0||t.isRunning===!0||n==="running",o=r?"paused":a?"running":"stopped";return{...t,state:o,eventStreamRootPath:t.eventStreamRootPath??t.runtime_dir??null,currentSegmentEventsPath:o==="stopped"?null:t.currentSegmentEventsPath??null,currentSegmentMetadataPath:o==="stopped"?null:t.currentSegmentMetadataPath??null,suppressedEventsPath:t.suppressedEventsPath??null,startedAtMs:t.startedAtMs??null,endedAtMs:t.endedAtMs??null}}
async function codexLinuxChronicleRequest({method:e,params:t}={}){let n,r=5000;if(e==="skysightStatus")n=["skysight","status"];else if(e==="skysightStart")n=["skysight","start","--source","chronicle-desktop","--owner","manual-continuous","--summary-agent","enabled"],r=15000;else if(e==="skysightPause"){if(t?.duration!=null)throw Error("Timed Linux Chronicle pause is unsupported");n=["skysight","pause","--reason","chronicle-desktop"],r=10000}else if(e==="skysightResume")n=["skysight","resume"],r=10000;else if(e==="skysightStop")n=["skysight","stop"],r=10000;else throw Error("Unsupported Linux Chronicle method: "+String(e));return codexLinuxChronicleUpstreamStatus(await codexLinuxRecordReplayRun(n,r))}
function codexLinuxChronicleControlStateFromSkysight(e){let t=codexLinuxChronicleStatusPayload(e);if(t==null)return{enabled:!1,running:!1,state:"disabled",error:e?.message||e?.stderr||e?.json?.error||"Invalid Linux Skysight status",skysight:e?.json??null};let n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused",o=n==="running"&&r&&!a;return{enabled:!0,running:o,state:o?"running":"stopped",skysight:t,chronicleOcrAvailable:t?.ocr_available===!0||t?.ocrAvailable===!0,chronicleOcrStatus:t?.ocr_status??t?.ocrStatus??"unknown",chronicleOcrBackend:t?.ocr_backend??t?.ocrBackend??null,chronicleOcrLanguage:t?.ocr_language??t?.ocrLanguage??null}}
async function codexLinuxChronicleSidecarControlStateAsync(){return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","status"],5000))}
function codexLinuxChronicleSummaryAgentArgs(e){return e===!0?["--summary-agent","enabled"]:e===!1?["--summary-agent","disabled"]:[]}
async function codexLinuxChronicleEnsureSidecarRunning(e,u,l){let t=await codexLinuxRecordReplayRun(["skysight","status"],5000),n=codexLinuxChronicleStatusPayload(t);if(n==null)return codexLinuxChronicleControlStateFromSkysight(t);let r=String(n.state),a=n?.is_running===!0||n?.isRunning===!0,o=n?.paused===!0||n?.is_paused===!0||n?.isPaused===!0||r==="paused",s=codexLinuxChronicleSummaryAgentArgs(e),i=e===!0&&(n?.summary_agent_enabled!==!0&&n?.summaryAgentEnabled!==!0),c=u||l||i;u&&s.push("--source",String(u));l&&s.push("--owner",String(l));if(r==="running"&&a&&!o)return c?codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000)):codexLinuxChronicleControlStateFromSkysight(t);if(a&&o){c&&await codexLinuxRecordReplayRun(["skysight","start",...s],15000);return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","resume"],10000))}return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000))}
async function codexLinuxChronicleToggleSidecar(){let e=await codexLinuxRecordReplayRun(["skysight","status"],5000),t=codexLinuxChronicleStatusPayload(e);if(t==null)return codexLinuxChronicleControlStateFromSkysight(e);let n=String(t.state),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused";if(n==="running"&&r&&!a)return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","pause"],10000));if(r&&a)return codexLinuxChronicleEnsureSidecarRunning(!0,"chronicle-tray","manual-continuous");return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start","--source","chronicle-tray","--owner","manual-continuous","--summary-agent","enabled"],15000))}`;
}

function matchAll(source, pattern) {
  return [...source.matchAll(pattern)];
}

function one(values) { return values.length === 1 ? values[0] : null; }
function rootAt(body, index) {
  return findMatchingBrace("{" + body.slice(0, index) + "}", 0) === index + 1;
}
function codeAt(body, index) {
  return findMatchingBrace("{" + body.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}
function scopedMatches(source, pattern, start = 0, end = source.length, root = true) {
  const body = source.slice(start, end);
  return matchAll(body, pattern).filter(match => codeAt(body, match.index) && (!root || rootAt(body, match.index)))
    .map(match => { match.index += start; return match; });
}
function statementAt(body, index, async = false) {
  if (!rootAt(body, index)) return false;
  try { new Script(async ? `async function probe(){${body.slice(0, index)}const __chronicleStatement=0;}` : `${body.slice(0, index)}const __chronicleStatement=0;`); return true; }
  catch { return false; }
}
function bindingWrites(body, name, root = true) {
  return scopedMatches(body, new RegExp(`(?<![\\w$.])(?:${escapeRegExp(name)}\\s*(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))|(?:\\+\\+|--)${escapeRegExp(name)}\\b)`, "gu"), 0, body.length, root);
}
function ownBinding(body, name, params = "") {
  try { new Script(`async function probe(${params}){${body}\n;let ${name};}`); return false; }
  catch { return true; }
}
function hasEscapedReservedIdentifier(source, names) {
  const reserved = new Set(names);
  for (const token of source.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu)) {
    if (!token[0].includes("\\u")) continue;
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
      (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (reserved.has(decoded) && codeAt(source, token.index)) return true;
  }
  return false;
}

function hasPatternBindingWrite(source, name, canonicalSpans) {
  const references = source.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "gu"));
  for (const reference of references) {
    if (canonicalSpans.some(span => span.start <= reference.index && reference.index < span.end)) continue;
    if (!codeAt(source, reference.index)) continue;
    const end = reference.index + name.length;
    const following = source.slice(end).replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*/u, "");
    if (/^(?:\(|\.|:|\?\.)/u.test(following)) continue;
    // A literal expression may replace a read, including a shorthand object
    // value, but cannot replace a destructuring or parenthesized write target.
    const parses = replacement => {
      try {
        new Script(source.slice(0, reference.index) + replacement + source.slice(end));
        return true;
      } catch {
        return false;
      }
    };
    if (!parses("(0)") && !parses(`${name}:(0)`)) return true;
  }
  return false;
}

function codeIncludes(body, snippet) {
  let cursor = body.indexOf(snippet);
  while (cursor >= 0) {
    if (codeAt(body, cursor)) return true;
    cursor = body.indexOf(snippet, cursor + 1);
  }
  return false;
}
function classMethod(source, owner, name) {
  const start = owner.open + 1, body = source.slice(start, owner.end - 1);
  const head = one(scopedMatches(body, new RegExp(`(?<![\\w$.])(?:async )?${escapeRegExp(name)}\\(([^)]*)\\)\\{`, "gu")));
  if (!head) return null;
  const open = start + head.index + head[0].length - 1, end = findMatchingBrace(source, open);
  return end < open ? null : { start: start + head.index, bodyStart: open + 1, bodyEnd: end, params: head[1], body: source.slice(open + 1, end) };
}

// Minifier string literals may use double quotes or template literals.
function hasLiteral(body, snippet) {
  return codeIncludes(body, snippet) || codeIncludes(body, snippet.replaceAll('"', "`"));
}

function literal(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:"${escaped}"|\`${escaped}\`)`;
}

function classBodiesMatching(source, header, requiredSnippets, scope, methods) {
  if (!scope) return [];
  const factory = source.slice(scope.factoryStart, scope.factoryEnd);
  return scopedMatches(source, header, scope.factoryStart, scope.factoryEnd).filter((match) => {
    const local = match.index - scope.factoryStart;
    if (!statementAt(factory, local) || bindingWrites(factory, match[1]).length) return false;
    const open = source.indexOf("{", match.index);
    const close = findMatchingBrace(source, open);
    if (close === -1) return false;
    const body = source.slice(open, close + 1);
    const owner = { start: match.index, open, end: close + 1 };
    if (!methods.every(name => classMethod(source, owner, name))) return false;
    match.owner = owner;
    return requiredSnippets.every((snippet) => hasLiteral(body, snippet));
  });
}

function chronicleControllerClassMatches(source, scope) {
  return classBodiesMatching(
    source,
    new RegExp(`\\bclass (${IDENTIFIER})\\{dependencies;cachedStatus=${IDENTIFIER};desiredState=`, "g"),
    [
      "shouldReconcileAfterServiceRespawn(){return\"running\"===this.desiredState}",
      "status(){return null==this.pendingStatus&&(this.pendingStatus=this.request(\"skysightStatus\")",
      "this.withFailedEnableRollback(",
      "this.request(\"skysightStart\")",
      "this.requestPauseResume(\"skysightPause\",e)",
      "this.requestPauseResume(\"skysightResume\")",
      "getSettings(){return this.dependencies.request({method:\"skysightGetSettings\",params:{}})}",
      "updateSettings(e){return this.dependencies.request({method:\"skysightUpdateSettings\",params:{settings:e}})}",
      "clearHistory(e,t){return this.dependencies.request({method:\"skysightClearHistory\",params:{interval:t,scope:e}})",
      "await this.request(\"skysightStop\")",
      "\"Failed to enable Chronicle and stop the recorder during rollback\"",
      "this.dependencies.archiveLegacyChronicleSkill()",
      "this.dependencies.reconcileComputerHistoryPluginInstallation(",
    ], scope, ["constructor", "status", "enable", "reconcileEnabled", "disable", "stop", "pause", "resume", "getSettings", "updateSettings", "clearHistory", "requestPauseResume", "request", "withFailedEnableRollback", "stopRecorder", "runSerialized"],
  );
}

function chronicleServiceClassMatches(source, scope) {
  return classBodiesMatching(
    source,
    new RegExp(
      `\\bclass (${IDENTIFIER}) extends ${IDENTIFIER}(?:\\.${IDENTIFIER})?\\{appServerConnection;getController;isEligible;loadApplications;loadApplicationsByBundleIdentifier;history;`,
      "g",
    ),
    [
      "async getState(){",
      "this.appServerConnection.isChronicleFeatureConfigured()",
      "async retryActivation(){",
      "this.appServerConnection.reconcileSkysightChronicle()",
      "async setEnabled(e){",
      "this.appServerConnection.enableSkysightChronicle()",
      "\"waiting_for_permissions\"",
      "async pause(){",
      "async resume(){",
      "this.appServerConnection.resumeChronicle()",
      "async getSettings(){",
      "async updateSettings(e){",
      "async listApplications(){",
      "this.loadApplications()",
      "async resolveApplications(e){",
      "this.loadApplicationsByBundleIdentifier(e)",
      "async listHistory(){",
      "this.history.list()",
      "async listHistorySuggestions(){",
      "this.history.listSuggestions()",
      "async listHistorySummaryIntervals(",
      "this.history.listSummaryIntervals(",
      "async clearHistory(e,t){",
      "this.appServerConnection.sendAppServerRequest(\"config/value/write\"",
      "Error(\"Chronicle is unavailable\")",
    ], scope, ["constructor", "getState", "retryActivation", "setEnabled", "pause", "resume", "getSettings", "updateSettings", "listApplications", "resolveApplications", "listHistory", "listHistorySuggestions", "listHistorySummaryIntervals", "clearHistory"],
  );
}

const LINUX_PLATFORM_CHECK = '"linux"===process.platform';
const LINUX_PLATFORM_PATTERN = '"linux"===process\\.platform';

function activeExpressionAt(body, index) {
  if (!rootAt(body, index)) return false;
  let prefix = body.slice(0, index);
  if (scopedMatches(prefix, /\breturn\b/gu).length) return false;
  if (prefix.endsWith(",")) prefix = prefix.slice(0, -1) + ";";
  try { new Script(`async function probe(){${prefix}const __chronicleExpression=0;}`); return true; }
  catch { return false; }
}

function controllerInitPlans(source, scope, patched) {
  const platform = LINUX_PLATFORM_PATTERN;
  const head = patched
    ? `\\((${IDENTIFIER})\\|\\|${platform}\\)&&\\((${IDENTIFIER})=new (${IDENTIFIER})\\(\\{`
    : `(?<![\\w$.])(${IDENTIFIER})&&\\((${IDENTIFIER})=new (${IDENTIFIER})\\(\\{`;
  const requestPrefix = patched ? `${platform}\\?codexLinuxChronicleRequest:` : "";
  const reconcilePrefix = patched ? `${platform}\\?\\(\\)=>\\{\\}:` : "";
  const archivePrefix = patched ? `${platform}\\?async\\(\\)=>\\{\\}:` : "";
  const shape = new RegExp(`^\\{request:${requestPrefix}(?<worker>${IDENTIFIER})\\.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:${reconcilePrefix}(?<param>${IDENTIFIER})=>\\{(?<manager>${IDENTIFIER})\\.reconcileComputerHistoryPluginInstallation\\(\\k<param>\\)\\},archiveLegacyChronicleSkill:${archivePrefix}async\\(\\)=>\\{null!=await (?<archive>${IDENTIFIER})\\(\\{codexHome:(?<home>${IDENTIFIER})\\.codexHome,reason:${literal("skysight_gate_enabled")}\\}\\)&&(?<cache>${IDENTIFIER})\\.broadcastQueryCacheInvalidation\\(\\[${literal("skills")}\\]\\)\\}\\}$`, "u");
  const body = source.slice(scope.startupStart, scope.startupEnd), plans = [];
  for (const match of scopedMatches(source, new RegExp(head, "gu"), scope.startupStart, scope.startupEnd)) {
    if (!activeExpressionAt(body, match.index - scope.startupStart)) continue;
    const open = match.index + match[0].length - 1, end = findMatchingBrace(source, open);
    if (end < open || source.slice(end + 1, end + 3) !== "))") continue;
    const object = source.slice(open, end + 1), fields = shape.exec(object)?.groups;
    if (!fields) continue;
    const nativeObject = patched ? object
      .replace(`request:${LINUX_PLATFORM_CHECK}?codexLinuxChronicleRequest:`, "request:")
      .replace(`reconcileComputerHistoryPluginInstallation:${LINUX_PLATFORM_CHECK}?()=>{}:`, "reconcileComputerHistoryPluginInstallation:")
      .replace(`archiveLegacyChronicleSkill:${LINUX_PLATFORM_CHECK}?async()=>{}:`, "archiveLegacyChronicleSkill:") : object;
    const linuxObject = nativeObject
      .replace("request:", `request:${LINUX_PLATFORM_CHECK}?codexLinuxChronicleRequest:`)
      .replace("reconcileComputerHistoryPluginInstallation:", `reconcileComputerHistoryPluginInstallation:${LINUX_PLATFORM_CHECK}?()=>{}:`)
      .replace("archiveLegacyChronicleSkill:", `archiveLegacyChronicleSkill:${LINUX_PLATFORM_CHECK}?async()=>{}:`);
    const gate = match[1], instance = match[2], className = match[3];
    plans.push({ start: match.index, end: end + 3, gate, instance, className, fields,
      current: `${gate}&&(${instance}=new ${className}(${nativeObject}))`,
      patched: `(${gate}||${LINUX_PLATFORM_CHECK})&&(${instance}=new ${className}(${linuxObject}))` });
  }
  return plans;
}

function controllerGetterPlans(source, graph, patched) {
  const scope = graph.scope, startup = source.slice(scope.startupStart, scope.startupEnd);
  const hostName = /^class ([A-Za-z_$][\w$]*)/u.exec(source.slice(scope.hostStart, scope.hostEnd))?.[1];
  if (!hostName) return [];
  const calls = scopedMatches(source, new RegExp(`(?<![\\w$.])new ${escapeRegExp(hostName)}\\(\\{`, "gu"), scope.startupStart, scope.startupEnd, false);
  const hostCall = one(calls);
  if (!hostCall) return [];
  const hostOpen = hostCall.index + hostCall[0].length - 1, hostEnd = findMatchingBrace(source, hostOpen);
  const hostOptions = source.slice(hostOpen + 1, hostEnd);
  const hostGetter = one(scopedMatches(hostOptions, new RegExp(`(?:^|,)getSkysightRecorderController:(${IDENTIFIER})(?=[,}]|$)`, "gu")));
  if (!hostGetter) return [];
  const iifes = scopedMatches(source, new RegExp(`(?:let|const|var) ${IDENTIFIER}=function\\(\\{([^{}()]*)\\}\\)\\{`, "gu"), scope.startupStart, scope.startupEnd);
  const owner = one(iifes.filter(head => {
    const open = head.index + head[0].length - 1, end = findMatchingBrace(source, open);
    return open < hostCall.index && hostCall.index < end;
  }));
  if (!owner || !activeExpressionAt(startup, owner.index - scope.startupStart)) return [];
  const parameter = one(scopedMatches(owner[1], new RegExp(`(?:^|,)getSkysightRecorderController:(${IDENTIFIER})(?=,|$)`, "gu")));
  if (!parameter || parameter[1] !== hostGetter[1]) return [];
  const open = owner.index + owner[0].length - 1, end = findMatchingBrace(source, open), argsOpen = end + 2;
  if (!source.startsWith("({", end + 1)) return [];
  const argsEnd = findMatchingBrace(source, argsOpen);
  if (source[argsEnd + 1] !== ")") return [];
  const linux = patched ? `${LINUX_PLATFORM_PATTERN}\\|\\|` : "";
  return scopedMatches(source, new RegExp(`getSkysightRecorderController:\\(\\)=>${linux}(${IDENTIFIER})\\(\\)\\.skysight\\?(${IDENTIFIER}):null,artifactSessionHostLifecycle:`, "gu"), argsOpen + 1, argsEnd)
    .map(match => ({ start: match.index, end: match.index + match[0].length, feature: match[1], instance: match[2],
      current: `getSkysightRecorderController:()=>${match[1]}().skysight?${match[2]}:null,artifactSessionHostLifecycle:`,
      patched: `getSkysightRecorderController:()=>${LINUX_PLATFORM_CHECK}||${match[1]}().skysight?${match[2]}:null,artifactSessionHostLifecycle:` }));
}

function serviceGatePlan(source, graph) {
  const scope = graph.scope, open = source.indexOf("{", scope.hostStart);
  const host = { start: scope.hostStart, open, end: scope.hostEnd };
  const method = classMethod(source, host, "createAppHost");
  if (!method) return null;
  const returns = scopedMatches(method.body, /\breturn\b/gu);
  const returned = one(scopedMatches(method.body, new RegExp(`return new (${IDENTIFIER})\\(\\{`, "gu")));
  if (returns.length !== 1 || !returned || !method.body.endsWith("})")) return null;
  const objectOpen = method.bodyStart + returned.index + returned[0].length - 1, objectEnd = findMatchingBrace(source, objectOpen);
  if (objectEnd !== method.bodyEnd - 2) return null;
  const gate = one(scopedMatches(source, new RegExp(`(?:^|,)chronicle:"darwin"===process\\.platform&&null!=this\\.options\\.getSkysightRecorderController\\?new (${IDENTIFIER})\\((${IDENTIFIER}),this\\.options\\.getSkysightRecorderController,\\(\\)=>(${IDENTIFIER})\\(\\)\\.skysight,`, "gu"), objectOpen + 1, objectEnd));
  return gate ? { start: gate.index, className: gate[1], feature: gate[3], method } : null;
}

function nativeChroniclePlan(source, graph, patched) {
  const scope = graph.scope;
  if (!scope || scope.hostStart == null) return null;
  const controller = one(chronicleControllerClassMatches(source, scope));
  const service = one(chronicleServiceClassMatches(source, scope));
  const init = one(controllerInitPlans(source, scope, patched));
  const getter = one(controllerGetterPlans(source, graph, patched));
  const gate = serviceGatePlan(source, graph);
  if (!controller || !service || !init || !getter || !gate || init.className !== controller[1] || init.instance !== getter.instance || service[1] !== gate.className || getter.feature !== gate.feature) return null;
  const startup = source.slice(scope.startupStart, scope.startupEnd);
  const platform = one(scopedMatches(startup, new RegExp(`(?<![\\w$.])${escapeRegExp(init.gate)}="darwin"===process\\.platform(?=[,;])`, "gu")));
  const instanceWrites = bindingWrites(startup, init.instance), initWrite = init.start + source.slice(init.start, init.end).indexOf(`${init.instance}=new `);
  const unexpectedWrites = instanceWrites.filter(match => scope.startupStart + match.index !== initWrite &&
    !(scope.startupStart + match.index < Math.min(init.start, getter.start) && new RegExp(`^${escapeRegExp(init.instance)}=null(?=[,;]|$)`, "u").test(startup.slice(match.index))));
  if (!platform || bindingWrites(startup, init.gate).length !== 1 || instanceWrites.length < 1 || instanceWrites.length > 2 || unexpectedWrites.length || !ownBinding(startup, init.instance) || ownBinding(startup, controller[1]) || ownBinding(startup, getter.feature) || ownBinding(gate.method.body, service[1], gate.method.params) || ownBinding(gate.method.body, getter.feature, gate.method.params)) return null;
  return { controller, service, init, getter, gate };
}

function outerHelperSpan(source, part) {
  const found = []; let cursor = source.indexOf(part);
  while (cursor >= 0) { found.push(cursor); cursor = source.indexOf(part, cursor + 1); }
  if (found.length !== 1 || !statementAt(source, found[0])) return null;
  return { start: found[0], end: found[0] + part.length };
}

function asyncHandlerLiteral(value) {
  if (!value.startsWith("async(")) return false;
  for (const arrow of matchAll(value, /=>/gu)) {
    try { new Script(`async function probe${value.slice(5, arrow.index)}{}`); return true; }
    catch { /* A nested/default arrow has not completed the parameter list. */ }
  }
  return false;
}

// Extensions may add their own handlers, but may not replace Chronicle's
// owned methods. This checks only literal registration/lexical authority;
// the dependent feature owns its exact action/helper payload contract.
function extensionHandlers(object, occupied) {
  let cursor = 0; const names = [];
  while (cursor < object.length) {
    while (/\s/u.test(object[cursor] ?? "") && cursor < object.length) cursor++;
    if (cursor === object.length) break;
    const key = /^"([^"\\\n]+)":/u.exec(object.slice(cursor));
    if (!key || occupied.has(key[1]) || ["__proto__", "prototype", "constructor"].includes(key[1])) return null;
    cursor += key[0].length;
    let end = cursor;
    for (; end <= object.length; end++) {
      if (end !== object.length && object[end] !== ",") continue;
      const value = object.slice(cursor, end);
      if (!rootAt(value, value.length)) continue;
      try { new Script(`(${value});`); }
      catch { continue; }
      if (!asyncHandlerLiteral(value)) return null;
      break;
    }
    if (end > object.length) return null;
    occupied.add(key[1]); names.push(key[1]); cursor = end === object.length ? end : end + 1;
  }
  return names.length ? names : null;
}

function registryExtensions(source, registrySpan, fetchSpan, ownedMethods) {
  const calls = scopedMatches(source, new RegExp(`(?<![\\w$.])Object\\.assign\\(${BRIDGE_HANDLERS_NAME},\\{`, "gu"));
  const occupied = new Set(ownedMethods), targets = new Set(), extensions = [];
  for (const call of calls) {
    if (call.index < registrySpan.end || call.index >= fetchSpan.start || !statementAt(source, call.index)) return null;
    const open = call.index + call[0].length - 1, end = findMatchingBrace(source, open);
    if (source.slice(end + 1, end + 3) !== ");") return null;
    const methods = extensionHandlers(source.slice(open + 1, end), occupied);
    if (!methods) return null;
    targets.add(call.index + "Object.assign(".length);
    extensions.push({ start: call.index, end: end + 3, methods });
  }
  const declaration = registrySpan.start + "const ".length;
  const references = scopedMatches(source, new RegExp(`(?<![\\w$])${BRIDGE_HANDLERS_NAME}(?![\\w$])`, "gu"), 0, source.length, false);
  if (references.some(reference => reference.index !== declaration && !targets.has(reference.index) &&
    !(fetchSpan.start <= reference.index && reference.index < fetchSpan.end))) return null;
  return extensions;
}

function completeHelperPlan(source, graph) {
  const parts = chronicleMainHelperParts(), spans = parts.map(part => outerHelperSpan(source, part));
  if (spans.some(span => !span)) return null;
  const functionNames = parts.flatMap(part => matchAll(part, /\bfunction ([A-Za-z_$][\w$]*)\(/gu).map(match => match[1]));
  const intrinsics = ["Object", "JSON", "Promise", "String", "Array", "Error", "require", "process"];
  if (hasEscapedReservedIdentifier(source, [...functionNames, BRIDGE_HANDLERS_NAME, ...intrinsics])) return null;
  for (const name of functionNames) {
    const definitions = scopedMatches(source, new RegExp(`\\b(?:async )?function ${escapeRegExp(name)}\\(`, "gu"));
    if (definitions.length !== 1 || !statementAt(source, definitions[0].index) || bindingWrites(source, name, false).length || hasPatternBindingWrite(source, name, spans)) return null;
  }
  const declarations = scopedMatches(source, new RegExp(`(?<![\\w$.])const ${BRIDGE_HANDLERS_NAME}=\\{`, "gu"));
  const registry = one(declarations);
  if (!registry || registry.index !== spans[1].start || bindingWrites(source, BRIDGE_HANDLERS_NAME).length !== 1) return null;
  for (const intrinsic of intrinsics) {
    if (ownBinding(source, intrinsic) || bindingWrites(source, intrinsic).length) return null;
  }
  const ownedMethods = matchAll(chronicleSkysightBridgeSource(), /"([^"\n]+)":async/gu).map(match => match[1]);
  const extensions = registryExtensions(source, spans[1], spans[2], ownedMethods);
  if (!extensions) return null;
  const factory = source.slice(graph.scope.factoryStart, graph.scope.factoryEnd), startup = source.slice(graph.scope.startupStart, graph.scope.startupEnd);
  for (const name of ["codexLinuxChronicleFetchHandler", "codexLinuxChronicleFetch", "codexLinuxChronicleRequest"]) if (ownBinding(factory, name)) return null;
  if (ownBinding(startup, "codexLinuxChronicleRequest")) return null;
  const site = graph.wrapperRequest;
  if (ownBinding(source.slice(site.methodBodyStart, site.methodBodyEnd), "codexLinuxChronicleFetchHandler", `${site.webContentsVar},${site.requestVar}`) || ownBinding(source.slice(site.methodBodyStart, site.methodBodyEnd), "codexLinuxChronicleFetch", `${site.webContentsVar},${site.requestVar}`)) return null;
  const route = fetchRouteSource(site), occurrences = countOccurrences(source, FETCH_ROUTE_MARKER);
  const prefix = source.slice(site.prefixStart, site.prefixEnd);
  if (occurrences !== 1 || countOccurrences(prefix, route) !== 1) return null;
  const at = source.indexOf(FETCH_ROUTE_MARKER, site.prefixStart);
  return { helpers: spans, route: { start: at, end: at + route.length }, registry: {
    name: BRIDGE_HANDLERS_NAME, start: spans[1].start, end: spans[1].end,
    extensionAt: spans[1].end, endMarker: BRIDGE_HANDLERS_END_MARKER,
    ownedMethods, extensions,
  } };
}

function inspectChronicleBridgeWithGraph(source, graph) {
  const drifted = reason => ({ state: "drifted", reason });
  if (!graph?.ok || !graph.scope) return drifted("Native request graph is unavailable");
  const current = nativeChroniclePlan(source, graph, false), patched = nativeChroniclePlan(source, graph, true);
  if (Boolean(current) === Boolean(patched)) return drifted("Missing, ambiguous or mixed native Chronicle binding");
  if (current) return hasChronicleArtifact(source) ? drifted("Partial Chronicle bridge artifacts") : { state: "current", graph, native: current, registry: null };
  const bridge = completeHelperPlan(source, graph);
  if (!bridge) return drifted("Incomplete Chronicle route/helper/registry authority");
  return { state: "patched", graph, native: patched, ...bridge };
}

function inspectChronicleBridge(source) {
  if (typeof source !== "string") return { state: "drifted", reason: "Expected source text" };
  try {
    const result = inspectChronicleBridgeWithGraph(source, inspectMainRequestSites(source));
    if (result.state === "drifted") return result;
    const { controller, service, init, getter, gate } = result.native;
    return { state: result.state, graph: result.graph, registry: result.registry,
      helpers: result.helpers, route: result.route,
      native: {
        controller: { name: controller[1], ...controller.owner },
        service: { name: service[1], ...service.owner },
        init: { start: init.start, end: init.end, gate: init.gate, instance: init.instance, className: init.className, ...init.fields },
        getter: { start: getter.start, end: getter.end, feature: getter.feature, instance: getter.instance },
        serviceGate: { start: gate.start, className: gate.className, feature: gate.feature, methodBodyStart: gate.method.bodyStart, methodBodyEnd: gate.method.bodyEnd },
      },
    };
  }
  catch { return { state: "drifted", reason: "Invalid Chronicle source structure" }; }
}

function chronicleControllerContract(source) { return inspectChronicleBridge(source).state; }

function chronicleMainHelperParts() {
  return [
    recordReplayRuntimeHelperSource(CHRONICLE_MODULE_EXPRESSIONS),
    chronicleSkysightBridgeHandlersSource(),
    chronicleSkysightFetchHelperSource(),
  ];
}

function chronicleMainHelperSource() {
  return `${chronicleMainHelperParts().join("\n")}\n`;
}

function insertModuleHelper(source, helper) {
  const prologue = ['"use strict";', "'use strict';"].find((value) => source.startsWith(value));
  const at = prologue == null ? 0 : prologue.length;
  return `${source.slice(0, at)}${helper}${source.slice(at)}`;
}

function applyChronicleSkysightMainBridgePatch(currentSource) {
  const patchName = "Chronicle / Skysight main bridge patch";
  const inspection = inspectChronicleBridgeWithGraph(currentSource, inspectMainRequestSites(currentSource));
  if (inspection.state === "patched") return currentSource;
  if (inspection.state !== "current") {
    warn("Could not find one coherent current Chronicle controller contract", patchName);
    return currentSource;
  }
  const { init, getter } = inspection.native, site = inspection.graph.wrapperRequest;
  const edits = [
    { start: init.start, end: init.end, text: init.patched },
    { start: getter.start, end: getter.end, text: getter.patched },
    { start: site.nativeStart, end: site.nativeStart, text: fetchRouteSource(site) },
  ].sort((left, right) => right.start - left.start);
  let patched = currentSource;
  for (const edit of edits) patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  patched = insertModuleHelper(patched, chronicleMainHelperSource());
  if (chronicleControllerContract(patched) !== "patched") {
    warn("Chronicle controller contract changed while patching", patchName);
    return currentSource;
  }
  return patched;
}

function hasChronicleArtifact(source) {
  return source.includes("codexLinuxChronicle") || source.includes("codexLinuxRecordReplay")
    || source.includes(FETCH_ROUTE_MARKER) || source.includes(BRIDGE_HANDLERS_END_MARKER);
}

// Main-bundle descriptors are tried independently against each chunk. This
// bridge needs the complete main inventory to reject duplicate/mixed owners
// and marker-free copies of the same native factory before preparing a write.
function applyChronicleSkysightToExtractedApp(extractedDir) {
  const inventory = findMainProcessChunks(extractedDir);
  const reject = message => {
    warn(message, "Chronicle / Skysight main bridge patch");
    return { matched: 0, changed: 0, changedAssets: [], reason: message };
  };
  if (!inventory) return reject("Missing main-process inventory");
  const records = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8");
    return { assetName, source, graph: inspectMainRequestSites(source) };
  });
  const owners = records.filter(record => record.graph.ok);
  if (owners.length !== 1) return reject("Missing or ambiguous native request owner cohort");
  const owner = owners[0], identity = owner.graph.scope?.factoryId;
  if (identity == null) return reject("Native request factory identity is unavailable");
  const cohort = records.filter(record => record.graph.factoryIds?.includes(identity) || hasChronicleArtifact(record.source));
  if (cohort.length !== 1 || cohort[0] !== owner) return reject("Duplicate, partial or mixed Chronicle owner cohort");
  const state = chronicleControllerContract(owner.source);
  if (state === "drifted") return reject("Incomplete current Chronicle controller/bridge contract");
  if (state === "patched") return { matched: 1, changed: 0, changedAssets: [] };
  const patchedSource = applyChronicleSkysightMainBridgePatch(owner.source);
  if (chronicleControllerContract(patchedSource) !== "patched") return reject("Chronicle bridge poststate is incomplete");
  return { matched: 1, ...patchWebviewAssets(inventory.buildDir, [{ assetName: owner.assetName, source: owner.source, patchedSource }]) };
}

const descriptors = [
  {
    id: "linux-chronicle-skysight-main-bridge",
    phase: "extracted-app:pre-webview",
    order: 151,
    apply: applyChronicleSkysightToExtractedApp,
  },
];

module.exports = {
  BRIDGE_HANDLERS_END_MARKER,
  BRIDGE_HANDLERS_NAME,
  applyChronicleSkysightMainBridgePatch,
  applyChronicleSkysightToExtractedApp,
  chronicleControllerContract,
  inspectChronicleBridge,
  chronicleSkysightBridgeHandlersSource,
  chronicleSkysightBridgeSource,
  chronicleSkysightFetchHelperSource,
  chronicleSkysightHelperSource,
  descriptors,
  recordReplayRuntimeHelperSource,
};
