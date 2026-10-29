"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const CHRONICLE_MODULE_EXPRESSIONS = Object.freeze({
  childProcessVar: 'require("node:child_process")',
  fsVar: 'require("node:fs")',
  pathVar: 'require("node:path")',
});
const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const CURRENT_HANDLER_ANCHOR = '"set-remote-wsl-connections-enabled":';
const RETIRED_HANDLER_ANCHOR = '"get-global-state":async({key:';

function chronicleHandlerAnchor(source) {
  if (
    countOccurrences(source, CURRENT_HANDLER_ANCHOR) === 1
    && countOccurrences(source, RETIRED_HANDLER_ANCHOR) === 0
  ) return CURRENT_HANDLER_ANCHOR;
  return null;
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

function recordReplayRuntimeHelperSource({ childProcessVar, fsVar, pathVar }) {
  return `function codexLinuxRecordReplayString(e){return typeof e==="string"&&e.trim().length>0?e.trim():null}
function codexLinuxRecordReplayBin(){let e=codexLinuxRecordReplayString(process.env.CODEX_RECORD_REPLAY_LINUX_BIN);if(e)return e;let t=[];try{process.resourcesPath&&t.push(${pathVar}.join(process.resourcesPath,"native","codex-record-replay-linux"))}catch{}try{t.push(${pathVar}.join(process.cwd(),"resources","native","codex-record-replay-linux"))}catch{}try{let e=process.env.PATH||"";for(let n of e.split(${pathVar}.delimiter))n&&t.push(${pathVar}.join(n,"codex-record-replay-linux"))}catch{}t.push("codex-record-replay-linux");for(let e of t){try{if(e==="codex-record-replay-linux"||${fsVar}.existsSync(e))return e}catch{}}return "codex-record-replay-linux"}
function codexLinuxRecordReplayParse(e){let t=String(e||"").trim();if(!t)return null;try{return JSON.parse(t)}catch{return{raw:t}}}
function codexLinuxRecordReplayRun(e,t){let n=codexLinuxRecordReplayBin();return new Promise(r=>{${childProcessVar}.execFile(n,e,{encoding:"utf8",timeout:t,maxBuffer:16777216},(t,a,o)=>{let s=codexLinuxRecordReplayParse(a);if(t)return r({ok:!1,command:n,args:e,message:t instanceof Error?t.message:String(t),code:t?.code??null,stdout:a||"",stderr:o||"",json:s});r({ok:!0,command:n,args:e,stdout:a||"",stderr:o||"",json:s})})})}
${chronicleSkysightHelperSource()}`;
}

function chronicleSkysightHelperSource() {
  return `function codexLinuxChronicleUpstreamStatus(e){let t=e?.json&&typeof e.json==="object"?e.json:null;if(!e?.ok||t==null)throw Error(e?.message||e?.stderr||"Linux Skysight command failed");let n=String(t.state||""),r=t.paused===!0||t.is_paused===!0||t.isPaused===!0||n==="paused",a=t.is_running===!0||t.isRunning===!0||n==="running",o=r?"paused":a?"running":"stopped";return{...t,state:o,eventStreamRootPath:t.eventStreamRootPath??t.runtime_dir??null,currentSegmentEventsPath:o==="stopped"?null:t.currentSegmentEventsPath??null,currentSegmentMetadataPath:o==="stopped"?null:t.currentSegmentMetadataPath??null,suppressedEventsPath:t.suppressedEventsPath??null,startedAtMs:t.startedAtMs??null,endedAtMs:t.endedAtMs??null}}
async function codexLinuxChronicleRequest({method:e,params:t}={}){let n,r=5000;if(e==="skysightStatus")n=["skysight","status"];else if(e==="skysightStart")n=["skysight","start","--source","chronicle-desktop","--owner","manual-continuous","--summary-agent","enabled"],r=15000;else if(e==="skysightPause"){if(t?.duration!=null)throw Error("Timed Linux Chronicle pause is unsupported");n=["skysight","pause","--reason","chronicle-desktop"],r=10000}else if(e==="skysightResume")n=["skysight","resume"],r=10000;else if(e==="skysightStop")n=["skysight","stop"],r=10000;else throw Error("Unsupported Linux Chronicle method: "+String(e));return codexLinuxChronicleUpstreamStatus(await codexLinuxRecordReplayRun(n,r))}
function codexLinuxChronicleControlStateFromSkysight(e){let t=e?.json&&typeof e.json==="object"?e.json:null;if(!e?.ok&&t==null)return{enabled:!1,running:!1,state:"disabled"};let n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused",o=n==="running"&&r&&!a;return{enabled:!0,running:o,state:o?"running":"stopped",skysight:t,chronicleOcrAvailable:t?.ocr_available===!0||t?.ocrAvailable===!0,chronicleOcrStatus:t?.ocr_status??t?.ocrStatus??"unknown",chronicleOcrBackend:t?.ocr_backend??t?.ocrBackend??null,chronicleOcrLanguage:t?.ocr_language??t?.ocrLanguage??null}}
async function codexLinuxChronicleSidecarControlStateAsync(){return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","status"],5000))}
function codexLinuxChronicleSummaryAgentArgs(e){return e===!0?["--summary-agent","enabled"]:e===!1?["--summary-agent","disabled"]:[]}
async function codexLinuxChronicleEnsureSidecarRunning(e,u,l){let t=await codexLinuxRecordReplayRun(["skysight","status"],5000),n=t?.json&&typeof t.json==="object"?t.json:null,r=String(n?.state||""),a=n?.is_running===!0||n?.isRunning===!0,o=n?.paused===!0||n?.is_paused===!0||n?.isPaused===!0||r==="paused",s=codexLinuxChronicleSummaryAgentArgs(e),i=e===!0&&(n?.summary_agent_enabled!==!0&&n?.summaryAgentEnabled!==!0),c=u||l||i;u&&s.push("--source",String(u));l&&s.push("--owner",String(l));if(r==="running"&&a&&!o)return c?codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000)):codexLinuxChronicleControlStateFromSkysight(t);if(a&&o){c&&await codexLinuxRecordReplayRun(["skysight","start",...s],15000);return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","resume"],10000))}return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000))}
async function codexLinuxChronicleToggleSidecar(){let e=await codexLinuxRecordReplayRun(["skysight","status"],5000),t=e?.json&&typeof e.json==="object"?e.json:null,n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused";if(n==="running"&&r&&!a)return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","pause"],10000));if(r&&a)return codexLinuxChronicleEnsureSidecarRunning(!0,"chronicle-tray","manual-continuous");return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start","--source","chronicle-tray","--owner","manual-continuous","--summary-agent","enabled"],15000))}`;
}

function matchAll(source, pattern) {
  return [...source.matchAll(pattern)];
}

// Minifier string literals may use double quotes or template literals.
function hasLiteral(body, snippet) {
  return body.includes(snippet) || body.includes(snippet.replaceAll('"', "`"));
}

function literal(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:"${escaped}"|\`${escaped}\`)`;
}

function classBodiesMatching(source, header, requiredSnippets) {
  return matchAll(source, header).filter((match) => {
    const open = source.indexOf("{", match.index);
    const close = findMatchingBrace(source, open);
    if (close === -1) return false;
    const body = source.slice(open, close + 1);
    return requiredSnippets.every((snippet) => hasLiteral(body, snippet));
  });
}

function chronicleControllerClassMatches(source) {
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
    ],
  );
}

function chronicleServiceClassMatches(source) {
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
    ],
  );
}

const LINUX_PLATFORM_CHECK = "\"linux\"===process.platform";
const LINUX_PLATFORM_PATTERN = '"linux"===process\\.platform';
const GATE_REASON_LOOKAHEAD = `(?=async\\(\\)=>\\{[\\s\\S]{0,300}?reason:${literal("skysight_gate_enabled")})`;

function chronicleControllerInitMatches(source, patched) {
  const pattern = patched
    ? `\\((${IDENTIFIER})\\|\\|${LINUX_PLATFORM_PATTERN}\\)&&\\((${IDENTIFIER})=new (${IDENTIFIER})\\(\\{request:${LINUX_PLATFORM_PATTERN}\\?codexLinuxChronicleRequest:(${IDENTIFIER})\\.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:${LINUX_PLATFORM_PATTERN}\\?\\(\\)=>\\{\\}:(?=${IDENTIFIER}=>\\{[^{}]{0,200}\\},archiveLegacyChronicleSkill:)`
    : `\\b(${IDENTIFIER})&&\\((${IDENTIFIER})=new (${IDENTIFIER})\\(\\{request:(${IDENTIFIER})\\.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:(?=${IDENTIFIER}=>\\{[^{}]{0,200}\\},archiveLegacyChronicleSkill:)`;
  return matchAll(source, new RegExp(pattern, "g"));
}

function chronicleArchiveDependencyMatches(source, patched) {
  const prefix = patched
    ? `archiveLegacyChronicleSkill:${LINUX_PLATFORM_PATTERN}\\?async\\(\\)=>\\{\\}:`
    : "archiveLegacyChronicleSkill:";
  return matchAll(source, new RegExp(`${prefix}${GATE_REASON_LOOKAHEAD}`, "g"));
}

function chronicleControllerGetterMatches(source, patched) {
  const pattern = patched
    ? `getSkysightRecorderController:\\(\\)=>${LINUX_PLATFORM_PATTERN}\\|\\|(${IDENTIFIER})\\(\\)\\.skysight\\?(${IDENTIFIER}):null,artifactSessionHostLifecycle:`
    : `getSkysightRecorderController:\\(\\)=>(${IDENTIFIER})\\(\\)\\.skysight\\?(${IDENTIFIER}):null,artifactSessionHostLifecycle:`;
  return matchAll(source, new RegExp(pattern, "g"));
}

// The upstream macOS-only Chronicle service stays gated; Linux drives the
// recorder controller through the bridge handlers instead.
function chronicleServiceGateMatches(source) {
  return matchAll(
    source,
    new RegExp(
      `chronicle:"darwin"===process\\.platform&&null!=this\\.options\\.getSkysightRecorderController\\?new (${IDENTIFIER})\\((${IDENTIFIER}),this\\.options\\.getSkysightRecorderController,\\(\\)=>(${IDENTIFIER})\\(\\)\\.skysight,`,
      "g",
    ),
  );
}

function coherentContract(matches) {
  const {
    archiveDependencies,
    controllerClasses,
    controllerInits,
    controllerGetters,
    serviceClasses,
    serviceGates,
  } = matches;
  if (
    archiveDependencies.length !== 1
    || controllerClasses.length !== 1
    || controllerInits.length !== 1
    || controllerGetters.length !== 1
    || serviceClasses.length !== 1
    || serviceGates.length !== 1
  ) return false;

  const controllerClass = controllerClasses[0][1];
  const init = controllerInits[0];
  const getter = controllerGetters[0];
  const serviceClass = serviceClasses[0][1];
  const gate = serviceGates[0];
  const initInstance = init[2];
  const initClass = init[3];
  const getterFeature = getter[1];
  const getterInstance = getter[2];
  const gateServiceClass = gate[1];
  const gateFeature = gate[3];
  return initClass === controllerClass
    && initInstance === getterInstance
    && gateServiceClass === serviceClass
    && gateFeature === getterFeature;
}

function chronicleControllerContract(source) {
  const shared = {
    controllerClasses: chronicleControllerClassMatches(source),
    serviceClasses: chronicleServiceClassMatches(source),
  };
  const current = {
    ...shared,
    archiveDependencies: chronicleArchiveDependencyMatches(source, false),
    controllerInits: chronicleControllerInitMatches(source, false),
    controllerGetters: chronicleControllerGetterMatches(source, false),
    serviceGates: chronicleServiceGateMatches(source),
  };
  const patched = {
    ...shared,
    archiveDependencies: chronicleArchiveDependencyMatches(source, true),
    controllerInits: chronicleControllerInitMatches(source, true),
    controllerGetters: chronicleControllerGetterMatches(source, true),
    serviceGates: chronicleServiceGateMatches(source),
  };
  const helper = recordReplayRuntimeHelperSource(CHRONICLE_MODULE_EXPRESSIONS);
  const bridge = chronicleSkysightBridgeSource();
  const handlerAnchor = chronicleHandlerAnchor(source);
  const bridgeInsertion = handlerAnchor == null ? null : `${bridge},${handlerAnchor}`;
  const handlerCount = handlerAnchor == null ? 0 : 1;
  const currentCoherent = coherentContract(current);
  const patchedCoherent = coherentContract(patched);
  const helperCount = countOccurrences(source, helper);
  const helperMarkerCount = countOccurrences(source, "function codexLinuxChronicleRequest(");
  const bridgeCount = countOccurrences(source, bridge);
  const bridgeInsertionCount = bridgeInsertion == null ? 0 : countOccurrences(source, bridgeInsertion);

  if (
    currentCoherent
    && !patchedCoherent
    && patched.archiveDependencies.length === 0
    && patched.controllerInits.length === 0
    && patched.controllerGetters.length === 0
    && helperCount === 0
    && helperMarkerCount === 0
    && bridgeCount === 0
    && (bridgeInsertion == null || bridgeInsertionCount === 0)
    && handlerCount === 1
  ) return "current";
  if (
    patchedCoherent
    && !currentCoherent
    && current.archiveDependencies.length === 0
    && current.controllerInits.length === 0
    && current.controllerGetters.length === 0
    && helperCount === 1
    && helperMarkerCount === 1
    && bridgeCount === 1
    && bridgeInsertionCount === 1
    && handlerCount === 1
  ) return "patched";
  return "drifted";
}

function applyChronicleSkysightMainBridgePatch(currentSource) {
  const patchName = "Chronicle / Skysight main bridge patch";
  const contract = chronicleControllerContract(currentSource);
  if (contract === "patched") return currentSource;
  if (contract !== "current") {
    warn("Could not find one coherent current Chronicle controller contract", patchName);
    return currentSource;
  }

  const handlerNeedle = chronicleHandlerAnchor(currentSource);
  if (handlerNeedle == null) {
    warn("Could not find current main handler object", patchName);
    return currentSource;
  }
  const helper = recordReplayRuntimeHelperSource(CHRONICLE_MODULE_EXPRESSIONS);
  const bridge = chronicleSkysightBridgeSource();
  const init = chronicleControllerInitMatches(currentSource, false)[0];
  const archiveDependency = chronicleArchiveDependencyMatches(currentSource, false)[0];
  const getter = chronicleControllerGetterMatches(currentSource, false)[0];
  const linux = LINUX_PLATFORM_CHECK;
  const initReplacement = `(${init[1]}||${linux})&&(${init[2]}=new ${init[3]}({request:${linux}?codexLinuxChronicleRequest:${init[4]}.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:${linux}?()=>{}:`;
  const archiveDependencyReplacement = `archiveLegacyChronicleSkill:${linux}?async()=>{}:`;
  const getterReplacement = `getSkysightRecorderController:()=>${linux}||${getter[1]}().skysight?${getter[2]}:null,artifactSessionHostLifecycle:`;
  let patched = currentSource
    .replace(init[0], () => initReplacement)
    .replace(archiveDependency[0], () => archiveDependencyReplacement)
    .replace(getter[0], () => getterReplacement)
    .replace(handlerNeedle, () => `${bridge},${handlerNeedle}`);
  patched = `${helper}\n${patched}`;
  if (chronicleControllerContract(patched) !== "patched") {
    warn("Chronicle controller contract changed while patching", patchName);
    return currentSource;
  }
  return patched;
}

const descriptors = [
  {
    id: "linux-chronicle-skysight-main-bridge",
    phase: "main-bundle",
    order: 151,
    apply: applyChronicleSkysightMainBridgePatch,
  },
];

module.exports = {
  applyChronicleSkysightMainBridgePatch,
  chronicleControllerContract,
  chronicleSkysightBridgeSource,
  chronicleSkysightHelperSource,
  descriptors,
  recordReplayRuntimeHelperSource,
};
