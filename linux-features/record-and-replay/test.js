#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { execFileSync } = require("node:child_process");
const {
  disabledLinuxFeatureCleanupHooks,
  enabledLinuxFeatureIds,
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  applyRecordReplayDictationTranscriptPatch,
  applyRecordReplayGlobalDictationTranscriptPatch,
  applyRecordReplayHudPatch,
  applyRecordReplayMainBridgePatch,
  descriptors,
  recordReplayBridgeSource,
  recordReplayHelperSource,
  recordReplayHudRuntimeSource,
} = require("./patch.js");
const {
  applyChronicleSkysightMainBridgePatch,
  recordReplayRuntimeHelperSource,
} = require("../chronicle-skysight/patch.js");

const {
  applyExtractedAppPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");

const featureDir = __dirname;

// Current rspack/SWC composer dictation block (double quotes, Yoda comparisons).
function currentComposerTranscriptFixture() {
  return [
    'export const __rspack_esm_ids=[72];export const __webpack_modules__={Composer(module,exports,load){',
    'load.d(exports,{dictate:()=>hook});var historyNS=load("History"),cleanupNS=load("Cleanup"),persistNS=load("Persist"),settingsNS=load("Settings");',
    'function hook(props){let{cleanupEnabled:cleanupEnabled}=props;let memo={},callback;',
    'memo[0]!==cleanupEnabled?(callback=async(request,retry)=>{let retrying=void 0!==retry&&retry,action={...request,abortController:new AbortController},abort=()=>{action.abortController.abort()};request.signal?.addEventListener("abort",abort,{once:!0}),request.signal?.aborted&&abort();let{analytics:analytics,audio:audio,handlers:handlers,recordingPersistence:history,requestDurationMs:duration}=action,attached="CHATGPT_DICTATION_RECORDING_SOURCE_ATTACHED_AUDIO"===analytics.recordingSource,completed=!1,logged=!1;',
    'pending.current=action,mounted.current&&!attached&&setAction(action.action);let generation=currentGeneration.current,recover=(phase,text,context)=>{};let started=Date.now(),recovered=!1,delivered=!1;return await (async()=>{try{',
    'let response=await (null!=action.recovery&&!action.streamingSession?.hasBoundaries()?transcribe(audio):stream(audio,{signal:action.abortController.signal,onTranscriptUpdate:(text,extra)=>{action.isCurrent?.()===!1?action.abortController.abort():handlers.onTranscriptUpdate?.(text,extra)},onRecover:()=>{recovered=!0}}));analytics.performance.mark("final_received");',
    'let cleaned=null!=handlers.chatgpt?response.text:await (0,cleanupNS.h)({transcript:response.text,surroundingText:handlers.getSurroundingText?.()??null,cleanupEnabled:cleanupEnabled,signal:action.abortController.signal});if(action.isCurrent?.()===!1&&action.abortController.abort(),action.abortController.signal.aborted)return;recoveryRef.current=null,mounted.current&&recoverState(!1);let text=null==handlers.chatgpt?cleaned.trim():cleaned;(0,persistNS.bE)(store.get(settingsNS.YV),analytics,text);let usedRetry=!1,recording=null!=action.recordingSignal&&!action.recordingSignal.aborted&&audio.size>0?audio:void 0,context=null==handlers.chatgpt&&null==recording?void 0:{signal:action.abortController.signal,response:response,assetResponse:assetResponse,recording:recording,recordingSignal:action.recordingSignal,recordingDurationMs:analytics.recordDurationMs,dictationSessionId:analytics.dictationSessionId,attemptId:analytics.attemptId,transcriptReceivedTs:analytics.timings?.transcriptReceivedTs??Date.now()};activeRef.current=null,mounted.current&&reset(void 0);let metadata={action:action.action,audioLost:!1,reason:"success",retrySameAudioAvailable:!1,stopReason:stopRef.current,transcript:text,transcriptionStartedAtMs:started};',
    'if(text.length>0||null!=context){text.length>0&&null==history&&null==handlers.chatgpt?historyNS.QY.getInstance().dispatchMessage("global-dictation-record-history-item",{text:text}):history?.setTranscript(text,void 0),analytics.performance.mark("transcript_dispatched");let session=history?.id;if(delivered=!0,null!=action.recovery&&null!=handlers.onRecoveryChange){if(recover("recovered",text,context),retrying&&mounted.current&&generation===currentGeneration.current){let promise=null==context?handlers.onTranscriptRetry?.(text,session):handlers.onTranscriptRetry?.(text,session,context);null==handlers.chatgpt||attached||state(analytics,{...metadata,action:null==handlers.onTranscriptRetry?metadata.action:"insert"}),await promise,usedRetry=null!=handlers.onTranscriptRetry}}else if("send"===action.action){let promise=null==context?handlers.onTranscriptSend(text,session):handlers.onTranscriptSend(text,session,context);null==handlers.chatgpt||attached||state(analytics,metadata),await promise}else{let promise=null==context?handlers.onTranscriptInsert(text,session):handlers.onTranscriptInsert(text,session,context);null==handlers.chatgpt||attached||state(analytics,metadata),await promise,pending.current===action&&"send"===pending.current.action&&await (null==context||null!=context.recording?handlers.onTranscriptSend("",session):handlers.onTranscriptSend("",session,context))}}',
    'else null!=handlers.onRecoveryChange&&(null!=action.recovery||recovered)?(recoveryRef.current=action,mounted.current&&recoverState(!0),recover("failed")):handlers.onTranscriptCancel?.();if(action.abortController.signal.aborted)return;state(analytics,{...metadata,action:action.action,recovery:null==action.recovery||null==handlers.onRecoveryChange?void 0:{phase:action.recovery.phase,transcriptInserted:usedRetry,retrySameAudioAvailable:mounted.current&&generation===currentGeneration.current&&recoveryRef.current===action}}),completed=!0',
    '}catch(error){if(action.abortController.signal.aborted)return;throw error}})().finally(()=>{request.signal?.removeEventListener("abort",abort),pending.current===action&&(pending.current=null)}),completed},memo[1]=callback):callback=memo[1];let invoke=callback;',
    'async function stop(){await invoke({action:nextAction,isCurrent:isCurrent,recovery:recovery,analytics:analytics,audio:audio,recordingSignal:recordingSignal,streamingSession:streamingSession,handlers:handlers,language:language,recordingPersistence:history,requestDurationMs:null==handlers.chatgpt?void 0:duration})}',
    'async function retry(){await invoke({...request,analytics:analytics},!0)}',
    'function insert(){return invoke({action:"insert",analytics:analytics,audio:audio,streamingSession:null,language:language,handlers:{...handlers,onTranscriptInsert:insertTranscript},recordingPersistence:null,requestDurationMs:duration,signal:signal})}',
    'return{stop,retry,insert}}},Opaque(module,exports,load){const data={nativeOpaque:"preserve"};},Other(){}};',
  ].join("");
}

function composerCallbackRuntime(source, options = {}) {
  const events = [], globals = {}, pending = { current: null }, generation = { current: 1 };
  if (options.capture !== undefined) globals.codexLinuxRecordReplayCaptureTranscript = (...args) => {
    events.push(["capture", ...args]);
    return options.capture(...args);
  };
  const inputSignal = new AbortController();
  const handlers = {
    chatgpt: options.chatgpt ?? null,
    getSurroundingText: () => "surrounding text",
    onTranscriptUpdate: (...args) => events.push(["native-update", ...args]),
    onTranscriptSend: (...args) => { events.push(["send", ...args]); if (options.nativeError) throw Error("native send failure"); return options.nativeDeferred ?? Promise.resolve(); },
    onTranscriptInsert: (...args) => { events.push(["insert", ...args]); if (options.nativeError) throw Error("native insert failure"); return options.nativeDeferred ?? Promise.resolve(); },
    onTranscriptRetry: (...args) => { events.push(["retry", ...args]); return Promise.resolve(); },
    onTranscriptCancel: () => events.push(["cancel"]),
    onRecoveryChange: options.recovery ? () => {} : null,
  };
  const history = options.history === false ? null : { id: "native-session", setTranscript: (...args) => { events.push(["history", ...args]); if (options.historyError) throw Error("native history failure"); } };
  const analytics = { performance: { mark: name => events.push(["mark", name]) }, recordingSource: options.attached ? "CHATGPT_DICTATION_RECORDING_SOURCE_ATTACHED_AUDIO" : "composer", recordDurationMs: 500, dictationSessionId: "dictation-session", attemptId: "attempt", timings: { transcriptReceivedTs: 1234 } };
  const asr = async (_audio, callbacks) => {
    events.push(["asr"]);
    if (options.abortAt === "asr") inputSignal.abort();
    if (options.stale) callbacks?.onTranscriptUpdate("partial", null);
    return { text: options.text ?? " raw transcript " };
  };
  const context = {
    globalThis: globals, Date: { now: () => options.now ?? 1234 }, AbortController, cleanupEnabled: true,
    pending, mounted: { current: options.mounted !== false }, setAction() {}, currentGeneration: generation,
    transcribe: asr, stream: asr,
    cleanupNS: { h: async parameters => { events.push(["cleanup", parameters.transcript, parameters.surroundingText]); if (options.abortAt === "cleanup") inputSignal.abort(); if (options.cleanupError) throw Error("native cleanup failure"); return options.cleaned ?? " cleaned transcript "; } },
    persistNS: { bE: (_value, _analytics, text) => events.push(["persist", text]) }, settingsNS: { YV: "native-setting" }, store: { get: value => value },
    historyNS: { QY: { getInstance: () => ({ dispatchMessage: (...args) => events.push(["history-dispatch", ...args]) }) } },
    recoveryRef: { current: null }, recoverState() {}, activeRef: { current: null }, reset() {}, stopRef: { current: "user" },
    assetResponse: { nativeAsset: true }, state: (_analytics, data) => events.push(["state", data.action]),
  };
  const marker = 'callback=async(request,retry)=>{', at = source.indexOf(marker);
  assert.ok(at >= 0);
  const open = at + marker.length - 1, end = findMatchingBrace(source, open);
  vm.runInNewContext('async function run(request,retry){' + source.slice(open + 1, end) + '};globalThis.run=run;', context);
  const request = { action: options.action ?? "send", recovery: options.recovery ? { phase: "recovering" } : null, analytics, audio: { size: 1 }, handlers, recordingPersistence: history, requestDurationMs: 500, signal: inputSignal.signal, isCurrent: () => !options.stale, recordingSignal: options.recording ? new AbortController().signal : undefined };
  return { events, globals, context, request, pending, generation, run: () => globals.run(request, options.retrying ?? false) };
}

// Previous Vite/rolldown composer dictation block (template literals, `x==null`).
function retiredComposerTranscriptFixture() {
  return "async function send(){let p=`Create an image of a neon cabin`,c={setTranscript(){}},a={dictationSessionId:`session-1`,performance:{mark(){}}},i={action:`send`,recovery:null},s={chatgpt:null,onRecoveryChange:null,onTranscriptRetry:async()=>{},onTranscriptSend:async(t,e)=>globalThis.events.push([`send`,t,e]),onTranscriptInsert:async(t,e)=>globalThis.events.push([`insert`,t,e]),onTranscriptCancel:()=>globalThis.events.push([`cancel`])},x=null,te={current:i};if(p.length>0||s.chatgpt!=null){c==null&&s.chatgpt==null?une.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:p}):c?.setTranscript(p),a.performance.mark(`transcript_dispatched`);let e=c==null?void 0:a.dictationSessionId;if(i.recovery!=null&&s.onRecoveryChange!=null){await s.onTranscriptRetry?.(p,e,x)}else if(i.action===`send`){let t=x==null?s.onTranscriptSend(p,e):s.onTranscriptSend(p,e,x);await t}else{let t=x==null?s.onTranscriptInsert(p,e):s.onTranscriptInsert(p,e,x);await t,te.current===i&&te.current.action===`send`&&await s.onTranscriptSend(``,e,x)}}else s.onTranscriptCancel?.()}";
}

// Current rspack/SWC global dictation success chain: the completion dispatch is
// the else branch of a recovery ternary and the dispatcher is a member access.
const CURRENT_GLOBAL_DICTATION_SOURCE =
  "async function U(e,t,n=null){let r=Date.now(),i=await (null==n?I(e.audio):W(n,e.audio));e.analytics.performance.mark(\"final_received\");let a=await E({transcript:i,cleanupEnabled:t});J===e&&(J=null),a.trim().length>0&&e.recordingPersistence?.setTranscript(a.trim()),null!=e.recovery&&null!=e.onRecoveryChange?globalThis.recovered(a):x.O1.dispatchMessage(\"global-dictation-completed\",{sessionId:e.sessionId,text:a}),e.analytics.performance.mark(\"transcript_dispatched\")}";
const RETIRED_GLOBAL_DICTATION_SOURCE =
  "async function U(e,t,n=null){let r=Date.now(),i=n==null?await I(e.audio):await W(n,e.audio);e.analytics.performance.mark(`final_received`);let a=await E({transcript:i,cleanupEnabled:t});J===e&&(J=null),a.trim().length>0&&e.recordingPersistence?.setTranscript(a.trim()),B.dispatchMessage(`global-dictation-completed`,{sessionId:e.sessionId,text:a}),e.analytics.performance.mark(`transcript_dispatched`)}";

// Current desktop fetch wrapper: only the dictation route remains upstream.
const FETCH_WRAPPER_FIXTURE = "class FetchWrapper{constructor(){this.options={chunkedMessageSender:{sendInlineMessageForView:(e,t)=>{(globalThis.viewMessages??=[]).push({view:e,message:t})}}}}async handleRequest(e,t){if(\"/codex/dictation-stream-connect-info\"===t.url)return void await this.handleDictationStreamConnectInfoRequest(e,t);throw Error(\"HTTP requests must use the HTTP fetch service.\")}async handleDictationStreamConnectInfoRequest(e,t){try{this.options.chunkedMessageSender.sendInlineMessageForView(e,{type:\"fetch-response\",responseType:\"success\",requestId:t.requestId,status:200,headers:{\"content-type\":\"application/json\"},bodyJsonString:\"{}\"})}catch(r){this.options.chunkedMessageSender.sendInlineMessageForView(e,{type:\"fetch-response\",responseType:\"error\",requestId:t.requestId,status:432,error:\"failed\"})}}}var fetchWrapper=new FetchWrapper;";

// Previous Vite/rolldown minifier shape (template literals, `x==null`, `var X=class`).
function retiredChronicleControllerFixture() {
  return [
    "var Base={Tf:class{}};",
    "var Empty={state:`stopped`,currentSegmentEventsPath:null,currentSegmentMetadataPath:null};",
    "var Hse=class{dependencies;cachedStatus=Empty;desiredState=`stopped`;pendingOperation=Promise.resolve();finishPendingPauseResume=null;pendingStatus=null;constructor(e){this.dependencies=e}getCachedStatus(){return this.cachedStatus}shouldReconcileAfterServiceRespawn(){return this.desiredState===`running`}status(){return this.pendingStatus??=this.request(`skysightStatus`).then(e=>(e.state===`stopped`&&this.finishPendingPauseResume?.(e),e)).finally(()=>{this.pendingStatus=null}),this.pendingStatus}enable(){return this.desiredState=`running`,this.runSerialized(()=>this.withFailedEnableRollback(async()=>(await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0),this.request(`skysightStart`)))).catch(e=>{throw this.desiredState===`running`&&(this.desiredState=`stopped`),e})}reconcileEnabled(){return this.desiredState=`running`,this.runSerialized(()=>this.withFailedEnableRollback(async()=>{await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0);let e=await this.status();return e.state===`stopped`?this.request(`skysightStart`):(this.desiredState===`running`&&(this.desiredState=e.state),e)}))}disable(){let e=this.desiredState;return this.desiredState=`stopped`,this.runSerialized(async()=>{let e=this.cachedStatus.state===`stopped`?this.cachedStatus:await this.stopRecorder();return this.dependencies.reconcileComputerHistoryPluginInstallation(!1),e}).catch(t=>{throw this.desiredState===`stopped`&&(this.desiredState=e),t})}stop(){return this.desiredState=`stopped`,this.runSerialized(()=>this.stopRecorder())}pause(e){let t=this.desiredState,n=e==null?`paused`:`running`;return this.desiredState=n,this.runSerialized(()=>this.requestPauseResume(`skysightPause`,e)).catch(e=>{throw this.desiredState===n&&(this.desiredState=t),e})}resume(){let e=this.desiredState;return this.desiredState=`running`,this.runSerialized(async()=>{let e=await this.status();return e.state===`stopped`?this.request(`skysightStart`):e.state===`running`?e:this.requestPauseResume(`skysightResume`)}).catch(t=>{throw this.desiredState===`running`&&(this.desiredState=e),t})}getSettings(){return this.dependencies.request({method:`skysightGetSettings`,params:{}})}updateSettings(e){return this.dependencies.request({method:`skysightUpdateSettings`,params:{settings:e}})}clearHistory(e,t){return this.dependencies.request({method:`skysightClearHistory`,params:{interval:t,scope:e}}).then(e=>(this.cachedStatus=e,e))}requestPauseResume(e,t){return new Promise((n,r)=>{this.finishPendingPauseResume=n,(e===`skysightPause`?this.dependencies.request({method:e,params:t==null?{}:{duration:t}}):this.dependencies.request({method:e,params:{}})).then(n,r)}).then(e=>(this.cachedStatus=e,e)).finally(()=>{this.finishPendingPauseResume=null})}request(e){return this.dependencies.request({method:e,params:{}}).then(e=>(this.cachedStatus=e,e))}async withFailedEnableRollback(e){try{return await e()}catch(e){try{await this.stopRecorder()}catch(t){throw AggregateError([e,t],`Failed to enable Chronicle and stop the recorder during rollback`)}throw e}}async stopRecorder(){let e=await this.request(`skysightStop`);if(e.state!==`stopped`||e.currentSegmentEventsPath!=null||e.currentSegmentMetadataPath!=null)throw Error(`invalid stop`);return e}runSerialized(e){let t=this.pendingOperation.then(e,e);return this.pendingOperation=t.then(()=>{},()=>{}),t}};",
    "var $O=class extends Base.Tf{constructor(e,t,n,r,i,a){super(),this.appServerConnection=e,this.getController=t,this.isEligible=n,this.loadApplications=r,this.loadApplicationsByBundleIdentifier=i,this.history=a}async getState(){let e=this.#i(),[t,n]=await Promise.all([this.appServerConnection.isChronicleFeatureConfigured(),e.status()]);return this.#t(t,n.state)}async retryActivation(){this.#r();try{await this.appServerConnection.reconcileSkysightChronicle()}catch{}return this.getState()}async setEnabled(e){if(!e)return this.#e();let t=this.#i();try{let e=await this.appServerConnection.enableSkysightChronicle();return await this.#n(!0),this.#t(!0,e.state)}catch(e){if(e===`pending`)return await this.#n(!0),{enabled:!0,recorderState:`stopped`,activationState:`waiting_for_permissions`};throw e}}async pause(){let e=await this.#i().pause();return this.#t(!0,e.state)}async resume(){this.#r();let e=await this.appServerConnection.resumeChronicle();return this.#t(e.enabled,e.running?`running`:`stopped`)}async getSettings(){return this.#i().getSettings()}async updateSettings(e){return this.#i().updateSettings(e)}async listApplications(){return this.#r(),this.loadApplications()}async resolveApplications(e){return this.#r(),this.loadApplicationsByBundleIdentifier(e)}async listHistory(){return this.#r(),this.history.list()}async listHistorySuggestions(){return this.#r(),this.history.listSuggestions()}async listHistorySummaryIntervals({sinceMs:e}){return this.#r(),this.history.listSummaryIntervals(e)}async clearHistory(e,t){await this.#i().clearHistory(e,t)}async#e(){return this.#i().disable()}#t(e,t){return{enabled:e,recorderState:t}}async#n(e){await this.appServerConnection.sendAppServerRequest(`config/value/write`,{keyPath:`chronicle`,value:e})}#r(){if(!this.isEligible())throw Error(`Chronicle is not available`)}#i(){this.#r();let e=this.getController();if(e==null)throw Error(`Chronicle is unavailable`);return e}};",
    "function Cr(){return{skysight:false}}let N=process.platform===`darwin`,xe;",
    "var Ce={requestComputerUseWorker(e){return globalThis.worker(e)}},Xe={reconcileComputerHistoryPluginInstallation(e){return globalThis.reconcileComputerHistoryPluginInstallation(e)}},U={broadcastQueryCacheInvalidation(){}},V={codexHome:`/tmp`};async function archive(e){return globalThis.archiveLegacyChronicleSkill(e)}",
    "N&&(xe=new Hse({request:Ce.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:e=>{Xe.reconcileComputerHistoryPluginInstallation(e)},archiveLegacyChronicleSkill:async()=>{await archive({codexHome:V.codexHome,reason:`skysight_gate_enabled`})&&U.broadcastQueryCacheInvalidation([`skills`])}}));",
    "var appOptions={getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null};",
    "var connection={enableSkysightChronicle:()=>xe.enable(),resumeChronicle:()=>xe.resume()};",
    "var Host=class{constructor(){this.options=appOptions;let i=connection;this.services={chronicle:process.platform===`darwin`&&this.options.getSkysightRecorderController!=null?new $O(i,this.options.getSkysightRecorderController,()=>Cr().skysight,()=>globalThis.applications,e=>globalThis.resolvedApplications,{list:()=>globalThis.history,listSuggestions:()=>globalThis.historySuggestions,listSummaryIntervals:e=>[e]}):void 0}}};var host=new Host;",
    FETCH_WRAPPER_FIXTURE,
  ].join("");
}

const { currentChronicleMainFixture: currentChronicleControllerFixture,
  evaluateChronicleFixture } = require("./fixtures/main-bridge.js");
require("./plugin-gate.test.js");
require("./main-contract.test.js");
require("./main-runtime.test.js");

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function repoRoot() {
  return path.resolve(featureDir, "../..");
}

function stageSharedChronicleBackend(workspace, installDir, fakeBinary) {
  execFileSync(
    "bash",
    [path.join(featureDir, "../chronicle-skysight/stage.sh")],
    {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_RECORD_REPLAY_LINUX_SOURCE: fakeBinary,
      },
      stdio: "pipe",
    },
  );
}

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-and-replay-feature-test-"));
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(path.resolve(__dirname, "../chronicle-skysight"), path.join(root, "chronicle-skysight"), { recursive: true });
    fs.cpSync(path.resolve(__dirname), path.join(root, "record-and-replay"), { recursive: true });
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withTempFeatureConfig(enabled, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-and-replay-config-test-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, JSON.stringify({ enabled }, null, 2));
    return fn(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("manifest keeps record-and-replay disabled by default", () => {
  const manifestPath = path.join(__dirname, "feature.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.id, "record-and-replay");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires, ["chronicle-skysight"]);
});

test("record-and-replay required files exist", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "feature.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "README.md")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "patch.js")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "stage.sh")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "cleanup.sh")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "test.js")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "plugin-template/.codex-plugin/plugin.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "plugin-template/.mcp.json")), true);
  assert.equal(fs.existsSync(path.join(__dirname, "plugin-template/skills/record-and-replay/SKILL.md")), true);
});

test("record-and-replay is opt-in and disabled unless configured", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadEnabledLinuxFeatures({ featuresRoot: root }), []);
  });
});

test("record-and-replay enables with chronicle-skysight dependency", () => {
  withTempFeatureRoot(["chronicle-skysight", "record-and-replay"], (root) => {
    const ids = enabledLinuxFeatureIds({ featuresRoot: root });
    assert.deepEqual(ids, ["chronicle-skysight", "record-and-replay"]);
    assert.deepEqual(loadEnabledLinuxFeatures({ featuresRoot: root }).map((feature) => feature.id), [
      "chronicle-skysight",
      "record-and-replay",
    ]);
  });
});

test("record-and-replay migrates direct config by enabling chronicle-skysight", () => {
  withTempFeatureRoot(["record-and-replay"], (root) => {
    assert.deepEqual(
      loadEnabledLinuxFeatures({ featuresRoot: root }).map((feature) => feature.id),
      ["chronicle-skysight", "record-and-replay"],
    );
  });
});

test("record-and-replay patch descriptor loads only when feature is enabled", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
  withTempFeatureConfig(["chronicle-skysight", "record-and-replay"], (root) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.deepEqual(loaded.map((descriptor) => descriptor.id), [
      "feature:chronicle-skysight:linux-chronicle-skysight-main-bridge",
      "feature:record-and-replay:record-and-replay-plugin-gate",
      "feature:record-and-replay:linux-record-replay-main-bridge",
      "feature:record-and-replay:record-replay-hud",
      "feature:record-and-replay:record-replay-dictation-transcript",
      "feature:record-and-replay:record-replay-global-dictation-transcript",
    ]);
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  });
});

test("record-and-replay webview descriptors locate rspack chunks by content needles", () => {
  const hud = descriptors.find((patch) => patch.id === "record-replay-hud");
  const dictation = descriptors.find((patch) => patch.id === "record-replay-dictation-transcript");
  const global = descriptors.find((patch) => patch.id === "record-replay-global-dictation-transcript");
  for (const descriptor of [hud, dictation, global]) {
    assert.ok(descriptor);
    assert.equal(descriptor.pattern, undefined, descriptor.id);
    assert.equal(descriptor.assetPattern, undefined, descriptor.id);
  }
  assert.deepEqual(hud.assetNeedles, ["codex-host-chunked-message-v1", "as __webpack_require__}"]);
  assert.deepEqual(dictation.assetNeedles, ["global-dictation-record-history-item", "transcript_dispatched"]);
  assert.deepEqual(global.assetNeedles, ["global-dictation-completed", "transcript_dispatched"]);
  assert.equal(dictation.assetMatch(currentComposerTranscriptFixture()), true);
  assert.equal(dictation.assetMatch(retiredComposerTranscriptFixture()), false);
});

test("record-and-replay patches the signed rspack webview and main chunks", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
  const root = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const assetsDir = path.join(root, "webview/assets");
  const assets = [
    ...fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js")),
    ...fs.readdirSync(path.join(assetsDir, "async")).filter((name) => name.endsWith(".js")).map((name) => `async/${name}`),
  ];
  const containing = (needles) => assets.filter((name) => {
    const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
    return needles.every((needle) => source.includes(needle));
  });
  const dictation = descriptors.find((patch) => patch.id === "record-replay-dictation-transcript");
  const dictationOwners = containing(dictation.assetNeedles)
    .filter((name) => dictation.assetMatch(fs.readFileSync(path.join(assetsDir, name), "utf8"), name));
  assert.equal(dictationOwners.length, 1, dictationOwners.join(","));
  const dictationSource = fs.readFileSync(path.join(assetsDir, dictationOwners[0]), "utf8");
  const dictationPatched = applyRecordReplayDictationTranscriptPatch(dictationSource);
  assert.notEqual(dictationPatched, dictationSource);
  assert.equal(applyRecordReplayDictationTranscriptPatch(dictationPatched), dictationPatched);

  const globalOwners = containing(["global-dictation-completed", "transcript_dispatched"]);
  assert.equal(globalOwners.length, 1, globalOwners.join(","));
  const globalSource = fs.readFileSync(path.join(assetsDir, globalOwners[0]), "utf8");
  const { value: globalPatched, warnings: globalWarnings } = captureWarns(() =>
    applyRecordReplayGlobalDictationTranscriptPatch(globalSource));
  assert.deepEqual(globalWarnings, []);
  assert.notEqual(globalPatched, globalSource);
  assert.match(globalPatched, /:\(\(\(\)=>\{let t=String\(a\?\?""\)\.trim\(\)/);

  const runtimeEntries = containing(["codex-host-chunked-message-v1", "as __webpack_require__}"]);
  assert.ok(runtimeEntries.length >= 1);
  for (const name of runtimeEntries) {
    const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
    const { value, warnings } = captureWarns(() => applyRecordReplayHudPatch(source));
    assert.deepEqual(warnings, [], name);
    assert.notEqual(value, source, name);
  }

  const buildDir = path.join(root, ".vite/build");
  const changed = [];
  for (const name of fs.readdirSync(buildDir).filter((entry) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(entry))) {
    const source = fs.readFileSync(path.join(buildDir, name), "utf8");
    const { value: chronicle } = captureWarns(() => applyChronicleSkysightMainBridgePatch(source));
    const { value: patched } = captureWarns(() => applyRecordReplayMainBridgePatch(chronicle));
    if (patched === chronicle) continue;
    changed.push(name);
    assert.equal(applyRecordReplayMainBridgePatch(patched), patched, name);
    assert.equal(applyChronicleSkysightMainBridgePatch(patched), patched, name);
    assert.doesNotThrow(() => new vm.Script(patched, { filename: name }), name);
  }
  assert.equal(changed.length, 1, changed.join(","));
});

test("record-and-replay bridge patch is idempotent and uses execFile", () => {
  assert.equal(descriptors.length, 5);
  const source = currentChronicleControllerFixture();

  const chroniclePatched = applyChronicleSkysightMainBridgePatch(source);
  const patched = applyRecordReplayMainBridgePatch(chroniclePatched);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayMainBridgePatch(patched), patched);
  assert.match(patched, /"linux-record-replay-doctor":async/);
  assert.match(
    patched,
    /const codexLinuxChronicleBridgeHandlers=\{[^\n]*\};\/\*codex-linux-chronicle-bridge-handlers-end\*\/\nfunction codexLinuxRecordReplayActiveSessionDir\([^\n]*\nfunction codexLinuxRecordReplayWriteTempJson\([^\n]*\nObject\.assign\(codexLinuxChronicleBridgeHandlers,\{"linux-record-replay-doctor":async/,
  );
  assert.match(patched, /"chronicle-permissions":async/);
  assert.match(patched, /chronicleSidecarPresent/);
  assert.match(patched, /chronicleSidecarProcessState/);
  assert.match(patched, /chronicleOcrAvailable/);
  assert.match(patched, /chronicleOcrStatus/);
  assert.match(patched, /chronicleOcrBackend/);
  assert.match(patched, /codexLinuxChronicleRequest/);
  assert.match(patched, /request:"linux"===process\.platform\?codexLinuxChronicleRequest:/);
  assert.match(patched, /chronicle:"darwin"===process\.platform&&/);
  assert.doesNotMatch(patched, /chronicle:[^?]*"linux"===process\.platform/);
  assert.match(patched, /codexLinuxChronicleControlStateFromSkysight/);
  assert.match(patched, /codexLinuxChronicleEnsureSidecarRunning/);
  assert.match(patched, /"chronicle-permissions":async\(\)=>\{let e=await codexLinuxChronicleSidecarControlStateAsync\(\)/);
  assert.doesNotMatch(patched, /"chronicle-permissions":async\(\)=>\{let e=await codexLinuxChronicleEnsureSidecarRunning/);
  assert.match(patched, /"skysight","status"/);
  assert.match(patched, /"linux-record-replay-status":async/);
  assert.match(patched, /"linux-record-replay-start":async/);
  assert.match(patched, /"--audio"/);
  assert.match(patched, /"--no-audio"/);
  assert.match(patched, /"linux-record-replay-skysight-start":async/);
  assert.match(patched, /"--summary-agent","enabled"/);
  assert.match(patched, /"--summary-agent","disabled"/);
  assert.match(patched, /"linux-record-replay-skysight-status":async/);
  assert.match(patched, /"linux-record-replay-skysight-pause":async/);
  assert.match(patched, /"linux-record-replay-skysight-resume":async/);
  assert.match(patched, /"linux-record-replay-skysight-update-exclusion":async/);
  assert.match(patched, /"linux-record-replay-speech-context":async/);
  assert.match(patched, /"linux-record-replay-speech-context-active":async/);
  assert.match(patched, /record\.speech-active/);
  assert.match(patched, /"linux-record-replay-browser-trace":async/);
  assert.match(patched, /"linux-record-replay-desktop-snapshot":async/);
  assert.match(patched, /"desktop-snapshot"/);
  assert.match(patched, /"linux-record-replay-stop-active":async/);
  assert.match(patched, /"linux-record-replay-cancel":async/);
  assert.match(patched, /"linux-record-replay-cancel-active":async/);
  assert.match(patched, /"linux-record-replay-draft-skill":async/);
  assert.match(patched, /"linux-record-replay-import-skill":async/);
  assert.match(patched, /\.execFile\(n,e,\{encoding:"utf8",timeout:t,maxBuffer:16777216\}/);
  assert.match(patched, /codexLinuxRecordReplayWriteTempJson/);
  assert.match(
    patched,
    /finally\{try\{require\("node:fs"\)\.unlinkSync\(c\)\}catch\{\}\}/,
  );
  assert.match(patched, /"browser-trace"/);
  assert.match(patched, /"--trace-file"/);
  assert.doesNotMatch(patched, /exec\(/);
  assert.doesNotMatch(patched, /shell:true/);
  assert.match(patched, /"--no-screenshot"/);
  assert.match(patched, /"--allow-unsupported"/);
  assert.doesNotMatch(patched, /"--target"/);
  assert.doesNotMatch(patched, /"--target-dir"/);
  assert.doesNotMatch(patched, /"--mode"/);
  assert.doesNotMatch(
    recordReplayBridgeSource({ fsVar: "fs" }),
    /chronicle-permissions|linux-record-replay-skysight/,
  );
});

test("record-and-replay bridge handlers are served through the Chronicle fetch route", async () => {
  const patched = applyRecordReplayMainBridgePatch(applyChronicleSkysightMainBridgePatch(currentChronicleControllerFixture()));
  const calls = [];
  const context = {
    console,
    globalThis: {},
    JSON,
    Promise,
    String,
    process: {
      platform: "linux",
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
    },
    require(id) {
      if (id === "node:child_process") {
        return {
          execFile(_bin, args, _options, callback) {
            calls.push(args);
            callback(null, JSON.stringify({ ok: true, state: "active", session_dir: "/tmp/session" }), "");
          },
        };
      }
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };
  evaluateChronicleFixture(patched, context);
  await context.globalThis.fetchWrapper.handleRequest("view", {
    requestId: "speech",
    url: "vscode://codex/linux-record-replay-speech-context-active",
    body: JSON.stringify({ transcript: "hello", source: "codex-global-dictation" }),
  });
  const [{ view, message }] = context.globalThis.viewMessages;
  assert.equal(view, "view");
  assert.equal(message.responseType, "success");
  assert.equal(message.requestId, "speech");
  assert.equal(JSON.parse(message.bodyJsonString).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["status"],
    ["record", "speech", "--session-dir", "/tmp/session", "--text", "hello", "--source", "codex-global-dictation"],
  ]);
});

test("record-and-replay rejects incomplete current bridge variants byte-identically", () => {
  const source = currentChronicleControllerFixture();
  const chroniclePatched = applyChronicleSkysightMainBridgePatch(source);
  const patched = applyRecordReplayMainBridgePatch(chroniclePatched);
  const moduleExpressions = {
    childProcessVar: 'require("node:child_process")',
    fsVar: 'require("node:fs")',
    pathVar: 'require("node:path")',
  };
  const bridgePayload = recordReplayBridgeSource(moduleExpressions);
  const helperPayload = recordReplayHelperSource(moduleExpressions);
  const registration = `Object.assign(codexLinuxChronicleBridgeHandlers,{${bridgePayload}});`;
  const variants = {
    "missing current bridge handler": patched.replace(
      '"linux-record-replay-status":async',
      '"linux-record-replay-status-missing":async',
    ),
    "misplaced bridge payload": `${patched.replace(registration, "")}${registration}`,
    "duplicate bridge payload": patched.replace(registration, `${registration}${registration}`),
    "missing registration end marker": patched.replace("/*codex-linux-record-replay-bridge-end*/", ""),
    "helper-only partial": `${helperPayload}\n${chroniclePatched}`,
    "duplicate helper payload": `${helperPayload}\n${patched}`,
  };

  for (const [name, drifted] of Object.entries(variants)) {
    assert.notEqual(drifted, patched, name);
    const { value, warnings } = captureWarns(() => applyRecordReplayMainBridgePatch(drifted));
    assert.equal(value, drifted, name);
    assert.equal(warnings.length, 1, name);
    assert.match(warnings[0], /Record & Replay main bridge patch/, name);
  }
});

test("record-and-replay requires the Chronicle bridge registry and fetch route", () => {
  const current = applyChronicleSkysightMainBridgePatch(currentChronicleControllerFixture());
  const variants = {
    "chronicle not applied": currentChronicleControllerFixture(),
    "missing registry end marker": current.replace("/*codex-linux-chronicle-bridge-handlers-end*/", ""),
    "duplicate registry end marker": `${current}/*codex-linux-chronicle-bridge-handlers-end*/`,
    "missing Chronicle fetch route": current.replace("/*codex-linux-chronicle-skysight-route*/", ""),
    "missing Chronicle registry": current.replace("const codexLinuxChronicleBridgeHandlers={", "const codexLinuxOtherHandlers={"),
    "missing record runner": current.replace("function codexLinuxRecordReplayRun(", "function codexLinuxRecordReplayExec("),
  };

  for (const [name, source] of Object.entries(variants)) {
    const { value, warnings } = captureWarns(() => applyRecordReplayMainBridgePatch(source));
    assert.equal(value, source, name);
    assert.equal(warnings.length, 1, name);
    assert.match(warnings[0], /Chronicle \/ Skysight dependency bridge is missing/, name);
  }
});

test("record-and-replay Chronicle helpers map Skysight status into upstream sidecar state", () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const context = {
    childProcess: {},
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
      pid: 4242,
    },
    JSON,
    String,
  };

  const state = vm.runInNewContext(
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:true,json:{ok:true,state:"running",is_running:true,paused:false}})`,
    context,
  );
  assert.equal(state.enabled, true);
  assert.equal(state.running, true);
  assert.equal(state.state, "running");

  const ocrState = vm.runInNewContext(
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:true,json:{ok:true,state:"running",is_running:true,ocr_available:true,ocr_status:"completed",ocr_backend:"tesseract-cli",ocr_language:"eng"}})`,
    context,
  );
  assert.equal(ocrState.chronicleOcrAvailable, true);
  assert.equal(ocrState.chronicleOcrStatus, "completed");
  assert.equal(ocrState.chronicleOcrBackend, "tesseract-cli");
  assert.equal(ocrState.chronicleOcrLanguage, "eng");

  const paused = vm.runInNewContext(
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:true,json:{ok:true,state:"paused",is_running:true,paused:true}})`,
    context,
  );
  assert.equal(paused.enabled, true);
  assert.equal(paused.running, false);
  assert.equal(paused.state, "stopped");

  const missing = vm.runInNewContext(
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:false,json:null})`,
    context,
  );
  assert.equal(missing.enabled, false);
  assert.equal(missing.running, false);
  assert.equal(missing.state, "disabled");
});

test("record-and-replay Chronicle permissions probe is side-effect free", async () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const calls = [];
  const context = {
    childProcess: {
      execFile(_bin, args, _options, callback) {
        calls.push(args);
        callback(null, JSON.stringify({ ok: true, state: "stopped", is_running: false, paused: false }), "");
      },
    },
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
      pid: 4242,
    },
    JSON,
    Promise,
    String,
  };

  const state = await vm.runInNewContext(`${helperSource};codexLinuxChronicleSidecarControlStateAsync()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["skysight", "status"]]);
  assert.equal(state.enabled, true);
  assert.equal(state.running, false);
  assert.equal(state.state, "stopped");
});

test("record-and-replay Chronicle setup probe starts stopped Linux Skysight", async () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const calls = [];
  const responses = [
    { ok: true, state: "stopped", is_running: false, paused: false },
    { ok: true, state: "running", is_running: true, paused: false },
  ];
  const context = {
    childProcess: {
      execFile(_bin, args, _options, callback) {
        calls.push(args);
        callback(null, JSON.stringify(responses.shift()), "");
      },
    },
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
      pid: 4242,
    },
    JSON,
    Promise,
    String,
  };

  const state = await vm.runInNewContext(`${helperSource};codexLinuxChronicleEnsureSidecarRunning()`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["skysight", "status"],
    ["skysight", "start"],
  ]);
  assert.equal(state.enabled, true);
  assert.equal(state.running, true);
  assert.equal(state.state, "running");
});

test("record-and-replay Chronicle setup probe enables summary agent when Settings turns Chronicle on", async () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const calls = [];
  const responses = [
    { ok: true, state: "stopped", is_running: false, paused: false },
    { ok: true, state: "running", is_running: true, paused: false, summary_agent_enabled: true },
  ];
  const context = {
    childProcess: {
      execFile(_bin, args, _options, callback) {
        calls.push(args);
        callback(null, JSON.stringify(responses.shift()), "");
      },
    },
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
      pid: 4242,
    },
    JSON,
    Promise,
    String,
  };

  const state = await vm.runInNewContext(`${helperSource};codexLinuxChronicleEnsureSidecarRunning(true)`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["skysight", "status"],
    ["skysight", "start", "--summary-agent", "enabled"],
  ]);
  assert.equal(state.enabled, true);
  assert.equal(state.running, true);
  assert.equal(state.state, "running");
});

test("record-and-replay Chronicle setup probe does not churn start when summary agent is already enabled", async () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const calls = [];
  const context = {
    childProcess: {
      execFile(_bin, args, _options, callback) {
        calls.push(args);
        callback(
          null,
          JSON.stringify({
            ok: true,
            state: "running",
            is_running: true,
            paused: false,
            summary_agent_enabled: true,
          }),
          "",
        );
      },
    },
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
      pid: 4242,
    },
    JSON,
    Promise,
    String,
  };

  const state = await vm.runInNewContext(`${helperSource};codexLinuxChronicleEnsureSidecarRunning(true)`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["skysight", "status"]]);
  assert.equal(state.enabled, true);
  assert.equal(state.running, true);
  assert.equal(state.state, "running");
});

test("record-and-replay generic Skysight start can pass summary agent true or false", async () => {
  const source = currentChronicleControllerFixture();
  const patched = applyChronicleSkysightMainBridgePatch(source);
  assert.match(
    patched,
    /"linux-record-replay-skysight-start":async\(\{intervalSeconds:e,summaryAgent:t,source:r,owner:a\}=\{\}\)=>\{let n=\["skysight","start"\]/,
  );
  assert.match(patched, /r&&n\.push\("--source",String\(r\)\)/);
  assert.match(patched, /a&&n\.push\("--owner",String\(a\)\)/);
  assert.match(patched, /t===!0&&n\.push\("--summary-agent","enabled"\)/);
  assert.match(patched, /t===!1&&n\.push\("--summary-agent","disabled"\)/);
});

test("record-and-replay patch connects to the current Chronicle controller surface", () => {
  const source = currentChronicleControllerFixture();
  const patched = applyChronicleSkysightMainBridgePatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyChronicleSkysightMainBridgePatch(patched), patched);
  assert.match(patched, /\(N\|\|"linux"===process\.platform\)&&\(xe=new Hse/);
  assert.match(patched, /getSkysightRecorderController:\(\)=>"linux"===process\.platform\|\|Cr\(\)\.skysight\?xe:null/);
  assert.match(patched, /chronicle:"darwin"===process\.platform&&/);
  assert.doesNotMatch(patched, /chronicle:[^?]*"linux"===process\.platform/);
});

test("record-and-replay rejects ambiguous Chronicle controller contracts byte-identically", () => {
  const current = currentChronicleControllerFixture();
  const source = current + current;
  assert.equal(applyChronicleSkysightMainBridgePatch(source), source);
});

test("record-and-replay rejects the retired Chronicle controller contract byte-identically", () => {
  const source = retiredChronicleControllerFixture();
  const result = captureWarns(() => applyChronicleSkysightMainBridgePatch(source));
  assert.equal(result.value, source);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /coherent current Chronicle controller contract/);
});

test("record-and-replay docs mention pause resume and Chronicle-compatible resources", () => {
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  assert.match(readme, /linux-record-replay-skysight-pause/);
  assert.match(readme, /linux-record-replay-skysight-resume/);
  assert.match(readme, /Chronicle-compatible resources/);
  assert.match(readme, /memories\/extensions\/chronicle\/resources/);

  const skill = fs.readFileSync(path.join(__dirname, "plugin-template/skills/record-and-replay/SKILL.md"), "utf8");
  assert.match(skill, /pause/);
  assert.match(skill, /resume/);
  assert.match(skill, /Chronicle-compatible resources/);
});

test("record-and-replay bridge temp trace files are private", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-bridge-temp-"));
  try {
    const tempRoot = path.join(workspace, "tmp");
    fs.mkdirSync(tempRoot, { mode: 0o777 });
    const helperSource = recordReplayHelperSource({
      childProcessVar: "childProcess",
      fsVar: "fs",
      pathVar: "path",
    });
    const tracePath = vm.runInNewContext(
      `${helperSource};codexLinuxRecordReplayWriteTempJson("{\\"ok\\":true}")`,
      {
        childProcess: {},
        fs,
        path,
        process: { env: { TMPDIR: tempRoot }, pid: 4242 },
        Date,
        Math,
        String,
      },
    );
    const traceDir = path.dirname(tracePath);
    assert.equal(fs.statSync(traceDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tracePath).mode & 0o777, 0o600);
    assert.equal(path.relative(tempRoot, traceDir).startsWith(".."), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function hudEntryFixture(id = 348410) {
  const detached = id === 357055;
  const startup = detached ? 'Main(e,t,r){r.a(e,async function(done,fail){let{initializeDetachedWindow:init}=await r.e(2).then(r.bind(r,"Detached"));let result=await init();window.addEventListener("pagehide",()=>result[Symbol.dispose](),{once:true});window.close();done()})}' : 'Main(e,t,r){r.a(e,async function(done,fail){await Promise.all([r.e(2)]).then(r.bind(r,"Root"));done()})}';
  return 'var cache={},modules={' + startup + ',Empty(){},Value(e,t){t.value=1},Gav4(e,t,r){let marker="codex-host-chunked-message-v1";r.d(t,{},{I:marker,Z:function(message){return "marker"in message&&message.marker===marker&&"transferId"in message&&"sequence"in message&&Number.isSafeInteger(message.sequence)&&"kind"in message&&"tokens"in message&&Array.isArray(message.tokens)}})},Receiver(e,t,r){var codec=r("Gav4");r.d(t,{},{read:class{receive(message){return (0,codec.Z)(message)?message:null}}})},Router(e,t,r){var codec=r("Gav4"),receiver=r("Receiver");let instance=new receiver.read;r.d(t,{},{route:function(message){return message.marker===codec.I?instance.receive(message):null}})}};function req(id){var item=cache[id];if(item)return item.exports;var item=cache[id]={exports:{}};modules[id].call(item.exports,item,item.exports,req);return item.exports}req.m=modules;var exported=req;import*as shared from"./shared.js";req.C(shared);var boot=req.O(void 0,["1"],()=>req("Main"));req.O(boot);export{exported as __webpack_require__};\n//# sourceMappingURL=' + id + '.js.map';
}

function hudAppFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-hud-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(root, "webview/index.html"), '<script type="module" src="/assets/shared.js"></script><script type="module" src="/assets/main.js"></script>');
  fs.writeFileSync(path.join(root, "webview/detached-window.html"), '<script type="module" src="/assets/shared.js"></script><script type="module" src="/assets/detached.js"></script>');
  fs.writeFileSync(path.join(assets, "main.js"), hudEntryFixture());
  fs.writeFileSync(path.join(assets, "detached.js"), hudEntryFixture(357055));
  fs.writeFileSync(path.join(assets, "shared.js"), 'export const __rspack_esm_ids=["1"];export const __webpack_modules__={Support(e,t,r){t.ready=true}};');
  const descriptor = descriptors.find(patch => patch.id === "record-replay-hud");
  const selected = normalizePatchDescriptors([{ ...descriptor, featureId: "record-and-replay", sourceKind: "feature" }]);
  return { root, assets, run() {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
    return report.patches[0];
  } };
}

function hudFixtureBytes(fixture) {
  return Object.fromEntries(["webview/index.html", "webview/detached-window.html", "webview/assets/main.js", "webview/assets/detached.js", "webview/assets/shared.js"]
    .map(name => [name, fs.readFileSync(path.join(fixture.root, name), "utf8")]));
}

function assertHudFixtureBytes(fixture, expected) {
  for (const [name, text] of Object.entries(expected)) assert.equal(fs.readFileSync(path.join(fixture.root, name), "utf8"), text, name);
}

test("UP71 HUD descriptor qualifies native entry bindings and complete source", () => {
  const descriptor = descriptors.find(patch => patch.id === "record-replay-hud");
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  const raw = hudEntryFixture();
  const patched = applyRecordReplayHudPatch(raw);
  assert.equal(applyRecordReplayHudPatch(patched), patched);
  assert.ok(patched.startsWith(raw));
  assert.equal(patched.split('globalThis.codexLinuxRecordReplayHudVersion=VERSION').length - 1, 1);
  for (const variant of [
    patched.replace('post("linux-record-replay-status"', 'post("wrong-handler"'),
    patched + recordReplayHudRuntimeSource(),
    raw.replace('var exported=req;', 'var exported=other;'),
    raw.replace('req.m=modules;', 'req.m=modulesOther;'),
    raw.replace('var exported=req;', 'var exported=req;exported=other;'),
    raw.replace('Array.isArray(message.tokens)', 'Array.isArray(other.tokens)'),
    raw.replace('(0,codec.Z)(message)', '(0,other.Z)(message)'),
    raw.replace('message.marker===codec.I', 'message.marker===other.I'),
    raw.replace('receiver=r("Receiver")', 'receiver=r("Other")'),
    raw.replace('new receiver.read', 'new other.read'),
    raw.replace('var boot=req.O', 'if(false)var boot=req.O'),
  ]) {
    const result = captureWarns(() => applyRecordReplayHudPatch(variant));
    assert.equal(result.value, variant);
    assert.equal(result.warnings.length, 1);
  }
  const markerData = raw + '\n/*codexLinuxRecordReplayHudVersion=*/';
  assert.notEqual(applyRecordReplayHudPatch(markerData), markerData);
  const unrelated = 'export const unrelated=1;';
  assert.equal(captureWarns(() => applyRecordReplayHudPatch(unrelated)).value, unrelated);
});

test("UP71 HUD descriptor preserves renamed native bindings and original UTF16 ranges", t => {
  const fixture = hudAppFixture(t), originals = new Map();
  for (const [name, id] of [["main.js", 348410], ["detached.js", 357055]]) {
    const source = 'var opaque="😀";\n' + hudEntryFixture(id).replace(/\breq\b/gu, "load").replace(/\bmodules\b/gu, "registry").replace(/\bexported\b/gu, "publicLoad").replace(/Gav4/gu, "RenamedCodec");
    originals.set(name, source);
    fs.writeFileSync(path.join(fixture.assets, name), source);
  }
  assert.equal(fixture.run().status, "applied");
  assert.equal(fixture.run().status, "already-applied");
  for (const [name, source] of originals) assert.ok(fs.readFileSync(path.join(fixture.assets, name), "utf8").startsWith(source));
});

function assertHudAuthorityRefusal(t, mutate, label) {
  const source = mutate(hudEntryFixture()), result = captureWarns(() => applyRecordReplayHudPatch(source));
  assert.equal(result.value, source, label);
  assert.equal(result.warnings.length, 1, label);
  const fixture = hudAppFixture(t);
  for (const [name, id] of [["main.js", 348410], ["detached.js", 357055]]) fs.writeFileSync(path.join(fixture.assets, name), mutate(hudEntryFixture(id)));
  const bytes = hudFixtureBytes(fixture), oldWrite = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
  try {
    const report = fixture.run();
    assert.equal(report.status, "skipped-optional", label);
    assert.match(report.reason, /Incomplete, duplicate or misplaced|Native runtime binding/u, label);
  } finally { fs.writeFileSync = oldWrite; }
  assert.equal(writes, 0, label);
  assertHudFixtureBytes(fixture, bytes);
}

test("UP71 HUD descriptor rejects drift in every complete HUD payload contract", t => {
  for (const [from, to] of [
    ['post("linux-record-replay-status"', 'post("wrong-status"'],
    ['post("linux-record-replay-stop-active"', 'post("wrong-stop"'],
    ['post("linux-record-replay-cancel-active"', 'post("wrong-cancel"'],
    ['post("linux-record-replay-speech-context"', 'post("wrong-speech"'],
    ['post("linux-record-replay-desktop-snapshot"', 'post("wrong-snapshot"'],
    ['hostId:"local"', 'hostId:"remote"'],
    ['method:"POST"', 'method:"GET"'],
    ['window.addEventListener("message",onMessage)', 'window.addEventListener("other",onMessage)'],
    ['timer=setInterval(tick,1000)', 'timer=setInterval(tick,100)'],
    ['codexLinuxRecordReplayCaptureTranscript=captureTranscript', 'codexLinuxRecordReplayCaptureTranscript=other'],
    ['if(/^\\/detached-window', 'if(/^\\/wrong-window'],
  ]) assertHudAuthorityRefusal(t, raw => applyRecordReplayHudPatch(raw).replace(from, to), from);
});

test("UP71 authority V3 covers the complete assignment and update operator table", t => {
  const assignments = ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??="];
  const expressions = assignments.map(operator => target => target + operator + "1");
  expressions.push(target => "++" + target, target => "--" + target, target => target + "++", target => target + "--");
  for (const expression of expressions) {
    const nativeTail = 'function rebind(){' + expression("exported") + ';}rebind();';
    assertHudAuthorityRefusal(t, raw => raw.replace('var exported=req;', 'var exported=req;' + nativeTail), nativeTail);
    for (const target of ['globalThis.codexLinuxRecordReplayCaptureTranscript', 'globalThis["codexLinuxRecordReplayCaptureTranscript"]']) {
      const tail = expression(target) + ";";
      assertHudAuthorityRefusal(t, raw => applyRecordReplayHudPatch(raw) + "\n" + tail, tail);
    }
    const fixture = hudAppFixture(t), shadow = 'function shadow(exported){' + expression("exported") + ';}';
    for (const name of ["main.js", "detached.js"]) fs.appendFileSync(path.join(fixture.assets, name), "\n" + shadow);
    assert.equal(fixture.run().status, "applied", shadow);
    assert.equal(fixture.run().status, "already-applied", shadow);
  }
});

test("UP71 authority V3 covers optional static owned deletes and grouped Unicode targets", t => {
  for (const tail of [
    'delete globalThis?.codexLinuxRecordReplayCaptureTranscript;',
    'delete window?.codexLinuxRecordReplayCaptureTranscript;',
    'delete self?.codexLinuxRecordReplayCaptureTranscript;',
    'delete globalThis?.["codexLinuxRecordReplayCaptureTranscript"];',
    "delete window?.['codexLinuxRecordReplayCaptureTranscript'];",
    'delete self?.[`codexLinuxRecordReplayCaptureTranscript`];',
    'delete (globalThis?.codexLinuxRecordReplayCaptureTranscript);',
    'delete ((globalThis))?.codexLinuxRecordReplayCaptureTranscript;',
    'delete ((globalThis))?.["codexLinuxRecordReplayCaptureTranscript"];',
    'delete globalThis?.\\u0063odexLinuxRecordReplayCaptureTranscript;',
    'delete globalThis?.["\\u0063odexLinuxRecordReplayCaptureTranscript"];',
    'delete globalThis?.["\\x63odexLinuxRecordReplayCaptureTranscript"];',
  ]) assertHudAuthorityRefusal(t, raw => applyRecordReplayHudPatch(raw) + "\n" + tail, tail);
});

test("UP71 authority V3 preserves destructuring and iteration target write boundaries", t => {
  for (const expression of [
    '({exported}=other)',
    '({value:exported}=other)',
    '[exported]=other',
    '[exported=other]=values',
    'for(exported of values){}',
    'for(exported in values){}',
    '(exported)++',
    '++(exported)',
    '\\u0065xported<<=1',
  ]) {
    const tail = 'function rebind(){' + expression + ';}rebind();';
    assertHudAuthorityRefusal(t, raw => raw.replace('var exported=req;', 'var exported=req;' + tail), tail);
  }
  for (const tail of [
    '({value:globalThis.codexLinuxRecordReplayCaptureTranscript}=other);',
    '[globalThis.codexLinuxRecordReplayCaptureTranscript]=other;',
    '[globalThis["codexLinuxRecordReplayCaptureTranscript"],other]=values;',
    'for([globalThis.codexLinuxRecordReplayCaptureTranscript] of values){}',
  ]) assertHudAuthorityRefusal(t, raw => applyRecordReplayHudPatch(raw) + "\n" + tail, tail);
});

test("UP71 authority permits local binding shadows and inert or foreign owned-name data", () => {
  for (const tail of [
    'function shadow(exported){exported=other;}',
    'function shadow({value:exported}){exported<<=1;}',
    'const shadow=({value:exported})=>exported>>=1;',
    'function shadow(){try{}catch({message:exported}){exported>>>=1;}}',
    'const values=[globalThis.codexLinuxRecordReplayCaptureTranscript];',
    'const values={value:globalThis.codexLinuxRecordReplayCaptureTranscript};',
    'let local;({[globalThis.codexLinuxRecordReplayCaptureTranscript]:local}=other);',
    'let local;[local=globalThis.codexLinuxRecordReplayCaptureTranscript]=other;',
    'let local;[local=(globalThis.codexLinuxRecordReplayCaptureTranscript)]=other;',
    'let local;[local=(globalThis["codexLinuxRecordReplayCaptureTranscript"])]=other;',
    'function shadow(){let {value:exported}=other;exported<<=1;}',
    'function shadow(){let [exported]=other;exported>>>=1;}',
    'const read=()=>exported<<1;',
    'globalThis.codexLinuxRecordReplayCaptureTranscript===undefined;',
    'globalThis.codexLinuxRecordReplayCaptureTranscript<=1;',
    'globalThis.otherFeature<<=1;',
    '/*delete globalThis?.codexLinuxRecordReplayCaptureTranscript; exported<<=1;*/',
    'const inert="delete globalThis?.codexLinuxRecordReplayCaptureTranscript; exported<<=1;";',
    'function shadow(){let exported;exported=other;}',
    'function shadow(){var exported;{exported=other;}}',
    'function shadow(){if(true){let exported;exported=other;}}',
    'function shadow(){try{}catch(exported){exported=other;}}',
    'function shadow(){for(let exported of other){exported=null;}}',
    'function shadow(){for(let exported=0;exported<2;exported++){exported=1;}}',
    'const shadow=(exported)=>exported=other;',
    'const shadow=(exported=null)=>exported=other;',
    'const shadow=exported=>()=>exported=other;',
    'const shadow=function exported(){exported=other;};',
    'function shadow(req,modules){req=other;modules={};}',
    'class Shadow{static{var exported;exported=null;}}',
    '/*delete globalThis.codexLinuxRecordReplayCaptureTranscript;*/',
    'const text="delete globalThis.codexLinuxRecordReplayCaptureTranscript;";',
    'globalThis.otherFeature=null;',
    'const inertDOM={id:"codex-linux-record-replay-hud"};',
    'const inertDOMText="node.id=codex-linux-record-replay-hud";',
    'Object.defineProperty(globalThis,"otherFeature",{value:null});',
  ]) {
    const source = hudEntryFixture() + "\n" + tail;
    const result = captureWarns(() => applyRecordReplayHudPatch(source));
    assert.notEqual(result.value, source, tail);
    assert.equal(result.warnings.length, 0, tail);
    assert.equal(applyRecordReplayHudPatch(result.value), result.value, tail);
  }
});

test("UP71 HUD descriptor commits the coherent two-entry cohort and validates warm dependencies", t => {
  const fixture = hudAppFixture(t), before = hudFixtureBytes(fixture);
  assert.equal(fixture.run().status, "applied");
  assert.equal(fixture.run().status, "already-applied");
  for (const name of ["main.js", "detached.js"]) {
    const text = fs.readFileSync(path.join(fixture.assets, name), "utf8");
    assert.equal(text.split('globalThis.codexLinuxRecordReplayHudVersion=VERSION').length - 1, 1);
  }
  assert.equal(fs.readFileSync(path.join(fixture.assets, "shared.js"), "utf8"), before['webview/assets/shared.js']);
  const otherRuntime = '\n;(()=>{globalThis.otherFeature=true})();';
  for (const name of ["main.js", "detached.js"]) fs.appendFileSync(path.join(fixture.assets, name), otherRuntime);
  assert.equal(fixture.run().status, "already-applied");
  for (const name of ["main.js", "detached.js"]) assert.ok(fs.readFileSync(path.join(fixture.assets, name), "utf8").endsWith(otherRuntime));
});

test("UP71 HUD descriptor refuses mixed partial orphan and bad native dependency cohorts before writes", t => {
  for (const kind of ["mixed", "wrong-handler", "orphan", "hidden-peer", "hidden-single", "hidden-template", "hidden-unicode", "hidden-hex", "missing-import", "wrong-startup", "html-role", "html-swapped", "duplicate-html"]) {
    const fixture = hudAppFixture(t);
    if (["mixed", "wrong-handler"].includes(kind)) {
      fs.writeFileSync(path.join(fixture.assets, "main.js"), applyRecordReplayHudPatch(hudEntryFixture()));
      if (kind === "wrong-handler") fs.writeFileSync(path.join(fixture.assets, "main.js"), fs.readFileSync(path.join(fixture.assets, "main.js"), "utf8").replace('post("linux-record-replay-status"', 'post("wrong-handler"'));
    } else if (kind === "orphan") fs.writeFileSync(path.join(fixture.assets, "extra.js"), recordReplayHudRuntimeSource());
    else if (kind.startsWith("hidden-")) {
      const peers = {
        "hidden-peer": 'globalThis["codexLinuxRecordReplayHudVersion"]="v6";',
        "hidden-single": "globalThis['codexLinuxRecordReplayCaptureTranscript']=()=>{};",
        "hidden-template": 'globalThis[`codexLinuxRecordReplayCaptureTranscript`]=()=>{};',
        "hidden-unicode": 'globalThis.\\u0063odexLinuxRecordReplayCaptureTranscript=()=>{};',
        "hidden-hex": "globalThis['\\x63odexLinuxRecordReplayCaptureTranscript']=()=>{};",
      };
      fs.writeFileSync(path.join(fixture.assets, "extra.js"), peers[kind]);
    }
    else if (kind === "missing-import") fs.writeFileSync(path.join(fixture.assets, "main.js"), hudEntryFixture().replace('req.C(shared);', 'other.C(shared);'));
    else if (kind === "wrong-startup") fs.writeFileSync(path.join(fixture.assets, "main.js"), hudEntryFixture().replace('()=>req("Main")', '()=>req("Other")'));
    else if (kind === "html-swapped") {
      fs.writeFileSync(path.join(fixture.root, "webview/index.html"), '<script type="module" src="/assets/shared.js"></script><script type="module" src="/assets/detached.js"></script>');
      fs.writeFileSync(path.join(fixture.root, "webview/detached-window.html"), '<script type="module" src="/assets/shared.js"></script><script type="module" src="/assets/main.js"></script>');
    }
    else if (kind === "html-role") fs.writeFileSync(path.join(fixture.root, "webview/detached-window.html"), '<script type="module" src="/assets/main.js"></script>');
    else fs.writeFileSync(path.join(fixture.root, "webview/index.html"), '<script type="module" src="/assets/main.js" src="/assets/detached.js"></script>');
    const bytes = hudFixtureBytes(fixture), oldWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(writes, 0, kind);
    assertHudFixtureBytes(fixture, bytes);
  }
});

test("UP71 HUD descriptor rolls back partial writes and protects changed read dependencies", t => {
  for (const kind of ["partial", "dependency-race", "html-race", "inventory-race"]) {
    const fixture = hudAppFixture(t), before = hudFixtureBytes(fixture), oldWrite = fs.writeFileSync;
    let written = false;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (String(file).endsWith('/main.js') && !written) {
        written = true;
        if (kind === "partial") { oldWrite(file, "partial"); throw Error("inert partial write"); }
        if (kind === "html-race") oldWrite(path.join(fixture.root, "webview/index.html"), before["webview/index.html"] + "<!-- concurrent -->");
        else if (kind === "dependency-race") oldWrite(path.join(fixture.assets, "shared.js"), before['webview/assets/shared.js'] + "\n// concurrent");
        else oldWrite(path.join(fixture.assets, "extra.js"), 'globalThis.codexLinuxRecordReplayHudVersion="unexpected";');
      }
      return oldWrite(file, bytes, ...options);
    };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(written, true);
    assert.equal(fs.readFileSync(path.join(fixture.assets, "main.js"), "utf8"), before['webview/assets/main.js']);
    assert.equal(fs.readFileSync(path.join(fixture.assets, "detached.js"), "utf8"), before['webview/assets/detached.js']);
  }
});

test("UP71 HUD descriptor detects warm inventory entry HTML and dependency races without own writes", t => {
  for (const kind of ["inventory", "entry", "html", "dependency"]) {
    const fixture = hudAppFixture(t);
    assert.equal(fixture.run().status, "applied");
    const oldReadDirectory = fs.readdirSync, oldWrite = fs.writeFileSync;
    let scans = 0, writes = 0;
    fs.readdirSync = (directory, ...options) => {
      if (String(directory) === fixture.assets && ++scans === 2) {
        const file = kind === "inventory" ? path.join(fixture.assets, "extra.js")
          : kind === "entry" ? path.join(fixture.assets, "main.js")
          : kind === "html" ? path.join(fixture.root, "webview/index.html")
          : path.join(fixture.assets, "shared.js");
        oldWrite(file, kind === "inventory" ? "const peer=true;" : fs.readFileSync(file, "utf8") + "\n/* concurrent */");
      }
      return oldReadDirectory(directory, ...options);
    };
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.readdirSync = oldReadDirectory; fs.writeFileSync = oldWrite; }
    assert.equal(scans, 2, kind);
    assert.equal(writes, 0, kind);
  }
});

test("UP71 HUD descriptor propagates fatal failure when rollback cannot restore an entry", t => {
  const fixture = hudAppFixture(t), oldWrite = fs.writeFileSync;
  let attempts = 0;
  fs.writeFileSync = (file, bytes, ...options) => {
    if (String(file).endsWith("/main.js")) {
      if (++attempts === 1) oldWrite(file, "partial");
      throw Error("inert write and restoration failure");
    }
    return oldWrite(file, bytes, ...options);
  };
  try { assert.throws(() => fixture.run(), /rollback could not restore original bytes/u); }
  finally { fs.writeFileSync = oldWrite; }
  assert.equal(attempts, 2);
});

test("record-and-replay HUD patch is idempotent and appends runtime UI", () => {
  const source = hudEntryFixture();
  const patched = applyRecordReplayHudPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayHudPatch(patched), patched);
  assert.match(patched, /sourceMappingURL=348410\.js\.map\n;\(\(\)=>/);
  assert.match(patched, /if\(\/\^\\\/detached-window/);
  const notEntry = "console.log('webview');";
  const rejected = captureWarns(() => applyRecordReplayHudPatch(notEntry));
  assert.equal(rejected.value, notEntry);
  assert.equal(rejected.warnings.length, 1);
  assert.match(rejected.warnings[0], /rspack webview runtime entry contract/);
  assert.match(patched, /codexLinuxRecordReplayHudVersion/);
  assert.match(patched, /codex-linux-record-replay-hud/);
  assert.match(patched, /linux-record-replay-status/);
  assert.match(patched, /linux-record-replay-stop-active/);
  assert.match(patched, /linux-record-replay-cancel-active/);
  assert.match(patched, /codexLinuxRecordReplayCaptureTranscript/);
  assert.match(patched, /codexLinuxRecordReplayPendingTranscripts/);
  assert.match(patched, /drainBootstrapTranscriptQueue/);
  assert.match(patched, /flushPendingTranscripts/);
  assert.match(patched, /linux-record-replay-speech-context/);
  assert.match(patched, /codex-dictation-/);
  assert.match(patched, /linux-record-replay-desktop-snapshot/);
  assert.match(patched, /record-replay-hud/);
  assert.match(patched, /captureDesktopSnapshot/);
  assert.match(patched, /I'm done recording\./);
  assert.match(patched, /submitDoneMessage/);
  assert.match(patched, /finishRecording/);
  assert.match(patched, /discardRecording/);
  assert.match(patched, /Discard this Record & Replay recording/);
  assert.doesNotMatch(patched, /codexLinuxRecordReplayVoiceControls/);
  assert.doesNotMatch(patched, /startDictation/);
  assert.doesNotMatch(patched, /stopDictation/);
  assert.doesNotMatch(patched, /finalizeVoiceCapture/);
});

test("record-and-replay rejects retired composer transcript contracts", () => {
  const sources = [
    retiredComposerTranscriptFixture(),
    "function send(e,n){let i=`Create an image of a neon cabin`;i.length>0&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))}",
    "async function send(){let l=c.trim();l.length>0?(o==null?_m.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:l}):o.setTranscript(l),r.performance.mark(`transcript_dispatched`),t.action===`send`?await a.onTranscriptSend(l):(await a.onTranscriptInsert(l),U.current===t&&U.current.action===`send`&&await a.onTranscriptSend(``))):a.onTranscriptCancel?.()}",
  ];
  for (const source of sources) {
    assert.equal(applyRecordReplayDictationTranscriptPatch(source), source);
  }
});

test("record-and-replay matches and executes the current composer transcript block", async () => {
  const source = currentComposerTranscriptFixture(), patched = applyRecordReplayDictationTranscriptPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayDictationTranscriptPatch(patched), patched);
  assert.match(patched, /codexLinuxRecordReplayCaptureTranscript\?\.\(text,action\.action\)/);
  const runtime = composerCallbackRuntime(patched, { capture: () => true });
  await runtime.run();
  assert.deepEqual(runtime.events.filter(event => ["capture", "send"].includes(event[0])), [
    ["capture", "cleaned transcript", "send"], ["send", "cleaned transcript", "native-session"],
  ]);
});

test("record-and-replay transcript repair rejects duplicate, partial, mixed, and ambiguous owners", () => {
  const current = currentComposerTranscriptFixture();
  const patched = applyRecordReplayDictationTranscriptPatch(current);
  const partial = patched.replace(
    "transcript_dispatched",
    "transcript_saved",
  );
  const variants = {
    "duplicate current": current + current,
    "duplicate patched": patched + patched,
    mixed: current + patched,
    partial,
    ambiguous: current.replace('else if("send"===action.action){', 'else if("send"===action.action){if(false){}else if("send"===action.action){}'),
  };
  const descriptor = descriptors.find((patch) => patch.id === "record-replay-dictation-transcript");

  assert.ok(descriptor);
  assert.equal(descriptor.assetMatch(current), true);
  assert.equal(descriptor.assetMatch(patched), true);
  for (const [name, source] of Object.entries(variants)) {
    assert.equal(descriptor.assetMatch(source), false, name);
    assert.equal(applyRecordReplayDictationTranscriptPatch(source), source, name);
  }
});

test("record-and-replay rejects the retired pre-analytics global dictation contract", () => {
  const source =
    "async function L(e,t,n=null){let r=await f({transcript:null==n?await y(e.audio):await R(n,e.audio),cleanupEnabled:t});U===e&&(U=null),a.dispatchMessage(\"global-dictation-completed\",{sessionId:e.sessionId,text:r})}";
  const result = captureWarns(() => applyRecordReplayGlobalDictationTranscriptPatch(source));

  assert.equal(result.value, source);
  assert.equal(result.warnings.length, 1);
});

test("record-and-replay rejects the retired template-literal global dictation chain", () => {
  const result = captureWarns(() => applyRecordReplayGlobalDictationTranscriptPatch(RETIRED_GLOBAL_DICTATION_SOURCE));
  assert.equal(result.value, RETIRED_GLOBAL_DICTATION_SOURCE);
  assert.equal(result.warnings.length, 1);
});

test("record-and-replay matches the current rspack global dictation success chain", () => {
  const source = CURRENT_GLOBAL_DICTATION_SOURCE;
  const patched = applyRecordReplayGlobalDictationTranscriptPatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayGlobalDictationTranscriptPatch(patched), patched);
  assert.match(patched, /codex-linux-record-replay-global-dictation/);
  assert.match(patched, /x\.O1\.dispatchMessage\("fetch",/);
  assert.match(patched, /x\.O1\.dispatchMessage\("global-dictation-completed",\{sessionId:e\.sessionId,text:a\}\)\),e\.analytics/);
});

test("record-and-replay keeps global dictation side effects inside the success branch", async () => {
  const patched = applyRecordReplayGlobalDictationTranscriptPatch(CURRENT_GLOBAL_DICTATION_SOURCE);
  const run = async (recovery) => {
    const context = {
      Date,
      Math,
      JSON,
      String,
      globalThis: { recovered() { context.events.push(["recovered"]); } },
      events: [],
      J: null,
      I: async () => "spoken words",
      W: async () => "spoken words",
      E: async ({ transcript }) => transcript,
      x: { O1: { dispatchMessage: (type, payload) => context.events.push([type, payload.url ?? payload.text]) } },
    };
    vm.runInNewContext(`${patched};globalThis.run=U`, context);
    await context.globalThis.run({
      audio: null,
      recovery,
      onRecoveryChange: recovery == null ? null : () => {},
      analytics: { performance: { mark: (name) => context.events.push(["mark", name]) } },
    }, false);
    return JSON.parse(JSON.stringify(context.events));
  };
  assert.deepEqual(await run(null), [
    ["mark", "final_received"],
    ["fetch", "vscode://codex/linux-record-replay-speech-context-active"],
    ["global-dictation-completed", "spoken words"],
    ["mark", "transcript_dispatched"],
  ]);
  assert.deepEqual(await run({ recordingId: "r1" }), [
    ["mark", "final_received"],
    ["recovered"],
    ["mark", "transcript_dispatched"],
  ]);
});

test("record-and-replay current transcript drift remains byte-identical", () => {
  const composer =
    "let l=c.trim();l.length>0&&(a==null?_m.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:l}):a.persistTranscript(l),t.performance.mark(`transcript_dispatched`),e.action===`send`?i.onTranscriptSend(l):i.onTranscriptInsert(l))";
  const global =
    "e.analytics.performance.mark(\"transcript_saved\"),x.O1.dispatchMessage(\"global-dictation-completed\",{sessionId:e.sessionId,text:a})";

  assert.equal(applyRecordReplayDictationTranscriptPatch(composer), composer);
  assert.equal(applyRecordReplayGlobalDictationTranscriptPatch(global), global);
});

test("record-and-replay generated transcript runtimes are syntactically valid", () => {
  const source = currentComposerTranscriptFixture();
  const globalDictationSource = CURRENT_GLOBAL_DICTATION_SOURCE;

  assert.doesNotThrow(() => new vm.Script(recordReplayHudRuntimeSource()));
  assert.equal(javascriptSourceParses(applyRecordReplayDictationTranscriptPatch(source)), true);
  assert.doesNotThrow(() => new vm.Script(applyRecordReplayGlobalDictationTranscriptPatch(globalDictationSource)));
});

test("record-and-replay HUD drains queued dictation transcripts into active bundle", async () => {
  const posted = [];
  const listeners = {};
  const makeElement = () => ({
    className: "",
    dataset: {},
    disabled: false,
    innerHTML: "",
    style: {},
    textContent: "",
    title: "",
    addEventListener() {},
    appendChild() {},
    closest() {
      return null;
    },
    contains() {
      return true;
    },
    focus() {},
    getBoundingClientRect() {
      return { height: 0, top: 0, width: 0 };
    },
    querySelector() {
      return makeElement();
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
  });
  const documentElement = makeElement();
  const context = {
    codexLinuxRecordReplayPendingTranscripts: [
      { action: "send", queuedAt: Date.now(), transcript: "Create an image of a neon cabin" },
    ],
    clearTimeout,
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    Date,
    document: {
      body: documentElement,
      createElement: makeElement,
      documentElement,
      getElementById() {
        return null;
      },
      head: documentElement,
      querySelectorAll() {
        return [];
      },
      readyState: "complete",
    },
    Error,
    Event: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    InputEvent: class {},
    KeyboardEvent: class {},
    Math,
    MutationObserver: class {
      observe() {}
    },
    Promise,
    setInterval() {
      return 1;
    },
    setTimeout,
    String,
  };
  context.document.contains = () => true;
  context.window = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    dispatchEvent() {},
    electronBridge: {
      sendMessageFromView(payload) {
        const method = payload.url.split("/").pop();
        const body = JSON.parse(payload.body ?? "{}");
        posted.push({ body, method });
        const response =
          method === "linux-record-replay-status"
            ? { json: { session_dir: "/tmp/recording", started_at: new Date().toISOString(), state: "active" } }
            : { json: { ok: true }, ok: true };
        setTimeout(() => {
          listeners.message?.({
            data: {
              bodyJsonString: JSON.stringify(response),
              requestId: payload.requestId,
              responseType: "success",
              type: "fetch-response",
            },
          });
        }, 0);
        return Promise.resolve();
      },
    },
    innerHeight: 800,
    innerWidth: 1200,
  };

  vm.runInNewContext(recordReplayHudRuntimeSource(), context);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.ok(
    posted.some(
      (request) =>
        request.method === "linux-record-replay-speech-context" &&
        request.body.transcript === "Create an image of a neon cabin" &&
        request.body.source === "codex-dictation-send",
    ),
  );
});

test("record-and-replay rejects the retired conversation-mode transcript gate", () => {
  const source =
    "function send(e,n){let i=`Create an image of a neon cabin`;i.length>0&&e!==`discard`&&globalThis.codexLinuxConversationShouldSendTranscript?.(i,e)!==!1&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))}";
  const patched = applyRecordReplayDictationTranscriptPatch(source);

  assert.equal(patched, source);
});

test("record-and-replay plugin template matches upstream-shaped plugin UX", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(featureDir, "plugin-template/.codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(featureDir, "plugin-template/.mcp.json"), "utf8"));
  const skill = fs.readFileSync(path.join(featureDir, "plugin-template/skills/record-and-replay/SKILL.md"), "utf8");

  assert.equal(plugin.name, "record-and-replay");
  assert.equal(plugin.interface.displayName, "Record & Replay");
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.skills, "./skills");
  assert.equal(plugin.interface.composerIcon, "./assets/app-icon.svg");
  assert.deepEqual(mcp.mcpServers["event-stream"], {
    command: "./bin/SkyLinuxComputerUseClient",
    args: ["event-stream", "mcp"],
    cwd: ".",
  });
  assert.match(skill, /^name: record-and-replay$/m);
  assert.match(skill, /same bundled\s+Record & Replay product shell/);
  assert.match(skill, /SkyLinuxComputerUseClient event-stream mcp/);
  assert.match(skill, /event_stream_start/);
  assert.match(skill, /event_stream_status/);
  assert.match(skill, /event_stream_stop/);
  assert.match(skill, /browser_trace/);
  assert.match(skill, /status/);
  assert.match(skill, /I'm done recording\./);
  assert.match(skill, /speech_context/);
  assert.match(skill, /not a raw pointer or keyboard macro recorder/);
});

test("record-and-replay stage hook records marketplace entry and stages plugin", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [{ name: "computer-use", source: { path: "./plugins/computer-use" } }] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);
    stageSharedChronicleBackend(workspace, installDir, fakeBinary);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
      },
      stdio: "pipe",
    });

    const nativeBinary = path.join(installDir, "resources/native/codex-record-replay-linux");
    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    assert.equal(fs.existsSync(nativeBinary), true);
    assert.equal(fs.statSync(nativeBinary).mode & 0o111 ? true : false, true);
    assert.equal(fs.existsSync(path.join(pluginDir, ".codex-plugin/plugin.json")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, ".mcp.json")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "assets/app-icon.svg")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "skills/record-and-replay/SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-record-replay-linux")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/SkyLinuxComputerUseClient")), true);
    assert.equal(fs.statSync(path.join(pluginDir, "bin/codex-record-replay-linux")).mode & 0o111 ? true : false, true);
    assert.equal(fs.statSync(path.join(pluginDir, "bin/SkyLinuxComputerUseClient")).mode & 0o111 ? true : false, true);

    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    const stagedMcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    assert.equal(stagedPlugin.interface.displayName, "Record & Replay");
    assert.equal(stagedPlugin.interface.logo, "./assets/app-icon.svg");
    assert.equal(stagedPlugin.interface.composerIcon, "./assets/app-icon.svg");
    assert.equal(Object.keys(stagedMcp.mcpServers)[0], "event-stream");
    assert.deepEqual(stagedMcp.mcpServers["event-stream"], {
      command: "./bin/SkyLinuxComputerUseClient",
      args: ["event-stream", "mcp"],
      cwd: ".",
    });

    const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
    assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "record-and-replay" && plugin.source?.path === "./plugins/record-and-replay"), true);
    assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "computer-use"), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay cleanup preserves Chronicle shared backend", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-cleanup-"));
  const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
  try {
    const featuresRoot = path.join(workspace, "features");
    const installDir = path.join(workspace, "install");
    fs.mkdirSync(featuresRoot, { recursive: true });
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.cpSync(featureDir, path.join(featuresRoot, "record-and-replay"), { recursive: true });

    const staleNative = path.join(installDir, "resources/native/codex-record-replay-linux");
    const stalePlugin = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(stalePlugin, { recursive: true });
    fs.mkdirSync(path.dirname(staleNative), { recursive: true });
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(staleNative, "stale");
    fs.writeFileSync(path.join(stalePlugin, "stale.txt"), "stale");
    fs.writeFileSync(
      marketplace,
      JSON.stringify({ plugins: [{ name: "record-and-replay" }, { name: "computer-use" }] }),
    );

    process.env.CODEX_LINUX_FEATURES_ROOT = featuresRoot;
    const cleanupHooks = disabledLinuxFeatureCleanupHooks({ featuresRoot });
    assert.deepEqual(cleanupHooks.map((hook) => hook.id), ["record-and-replay"]);
    execFileSync("bash", [cleanupHooks[0].path], {
      cwd: workspace,
      env: { ...process.env, SCRIPT_DIR: repoRoot(), INSTALL_DIR: installDir },
      stdio: "pipe",
    });
    stageEnabledLinuxFeatureInstall(installDir, { featuresRoot });

    assert.equal(fs.existsSync(staleNative), true);
    assert.equal(fs.existsSync(stalePlugin), false);
    const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
    assert.deepEqual(parsedMarketplace.plugins.map((plugin) => plugin.name), ["computer-use"]);
  } finally {
    if (originalRoot == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay stage hook uses the current upstream plugin shell when present", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-upstream-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const upstreamPlugin = path.join(
      workspace,
      "upstream/ChatGPT/resources/plugins/openai-bundled/plugins/record-and-replay",
    );
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(path.join(upstreamPlugin, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "assets"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "bin"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "skills/record-and-replay"), { recursive: true });
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(
      path.join(upstreamPlugin, ".codex-plugin/plugin.json"),
      JSON.stringify({
        name: "record-and-replay",
        version: "1.0.1000502",
        description: "Record what I'm doing on my Mac",
        author: { name: "OpenAI" },
        mcpServers: "./.mcp.json",
        skills: "./skills/",
        interface: {
          displayName: "Record & Replay",
          shortDescription: "Record what I'm doing on my Mac and turn it into a Skill",
          logo: "./assets/app-icon.png",
          brandColor: "#0F172A",
        },
        keywords: ["record-and-replay", "macos", "recording"],
      }),
    );
    fs.writeFileSync(
      path.join(upstreamPlugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "event-stream": {
            command: "./bin/computer-use-client-launcher",
            args: ["event-stream", "mcp"],
            cwd: ".",
            env_vars: ["CODEX_HOME"],
          },
        },
      }),
    );
    fs.writeFileSync(path.join(upstreamPlugin, "assets/app-icon.png"), "official-png");
    fs.writeFileSync(path.join(upstreamPlugin, "bin/computer-use-client-launcher"), "#!/bin/sh\nexec false\n");
    fs.chmodSync(path.join(upstreamPlugin, "bin/computer-use-client-launcher"), 0o755);
    fs.writeFileSync(path.join(upstreamPlugin, "skills/record-and-replay/SKILL.md"), "official mac skill");
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);
    stageSharedChronicleBackend(workspace, installDir, fakeBinary);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_UPSTREAM_APP_DIR: path.join(workspace, "upstream/ChatGPT"),
      },
      stdio: "pipe",
    });

    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    const stagedMcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    const stagedSkill = fs.readFileSync(path.join(pluginDir, "skills/record-and-replay/SKILL.md"), "utf8");

    assert.equal(fs.readFileSync(path.join(pluginDir, "bin/computer-use-client-launcher"), "utf8"), "#!/bin/sh\nexec false\n");
    assert.equal(fs.readFileSync(path.join(pluginDir, "assets/app-icon.png"), "utf8"), "official-png");
    assert.equal(stagedPlugin.version, "1.0.1000502");
    assert.equal(stagedPlugin.description, "Record what I'm doing on Linux");
    assert.equal(stagedPlugin.interface.shortDescription, "Record what I'm doing on Linux and turn it into a Skill");
    assert.equal(stagedPlugin.interface.logo, "./assets/record-and-replay-plugin-icon.png");
    assert.equal(stagedPlugin.interface.composerIcon, "./assets/record-and-replay-plugin-icon.png");
    assert.equal(stagedPlugin.keywords.includes("macos"), false);
    assert.equal(stagedPlugin.keywords.includes("linux"), true);
    assert.deepEqual(stagedMcp.mcpServers["event-stream"], {
      command: "./bin/SkyLinuxComputerUseClient",
      args: ["event-stream", "mcp"],
      cwd: ".",
    });
    assert.match(stagedSkill, /event_stream_start/);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-record-replay-linux")), true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/SkyLinuxComputerUseClient")), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay stage hook rejects the obsolete nested-app plugin shell", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-obsolete-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const upstreamPlugin = path.join(
      workspace,
      "upstream/ChatGPT/resources/plugins/openai-bundled/plugins/record-and-replay",
    );
    const oldClient = path.join(
      upstreamPlugin,
      "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    );
    const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
    fs.mkdirSync(path.join(upstreamPlugin, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "bin"), { recursive: true });
    fs.mkdirSync(path.join(upstreamPlugin, "skills/record-and-replay"), { recursive: true });
    fs.mkdirSync(path.dirname(oldClient), { recursive: true });
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(
      path.join(upstreamPlugin, ".codex-plugin/plugin.json"),
      JSON.stringify({
        name: "record-and-replay",
        version: "1.0.857",
        mcpServers: "./.mcp.json",
        skills: "./skills/",
      }),
    );
    fs.writeFileSync(
      path.join(upstreamPlugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "event-stream": {
            command:
              "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
            args: ["event-stream", "mcp"],
            cwd: ".",
          },
        },
      }),
    );
    fs.writeFileSync(path.join(upstreamPlugin, "skills/record-and-replay/SKILL.md"), "obsolete mac skill");
    fs.writeFileSync(path.join(upstreamPlugin, "bin/computer-use-client-launcher"), "#!/bin/sh\nexec false\n");
    fs.chmodSync(path.join(upstreamPlugin, "bin/computer-use-client-launcher"), 0o755);
    fs.writeFileSync(oldClient, "mach-o");
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);
    stageSharedChronicleBackend(workspace, installDir, fakeBinary);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_UPSTREAM_APP_DIR: path.join(workspace, "upstream/ChatGPT"),
      },
      stdio: "pipe",
    });

    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(stagedPlugin.version, "0.1.0-linux-alpha1");
    assert.equal(fs.existsSync(path.join(pluginDir, "Codex Computer Use.app")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("record-and-replay stage hook borrows upstream webview icon when present", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-stage-icon-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const assetsDir = path.join(installDir, "resources");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "record-and-replay-plugin-icon-fixture.png"), "fake-png");
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);
    stageSharedChronicleBackend(workspace, installDir, fakeBinary);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
      },
      stdio: "pipe",
    });

    const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/record-and-replay");
    const borrowedIcon = path.join(pluginDir, "assets/record-and-replay-plugin-icon.png");
    assert.equal(fs.readFileSync(borrowedIcon, "utf8"), "fake-png");

    const stagedPlugin = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(stagedPlugin.interface.logo, "./assets/record-and-replay-plugin-icon.png");
    assert.equal(stagedPlugin.interface.composerIcon, "./assets/record-and-replay-plugin-icon.png");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

async function settleHudPromises(turns = 40) {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

function inertHudRuntime({ detached = false, bridge = true, autoReply = true, loading = false, bootstrap = [], preexistingStyle = false } = {}) {
  const requests = [], events = [], observers = [], timers = new Map(), intervals = new Map();
  let now = 1_000_000, sequence = 0, status = { state: "idle" }, confirmation = true, confirmations = 0, sent = 0;
  class Element {
    constructor(tag = "div") { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.disabled = false; this.value = ""; this.dispatched = []; }
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    contains(child) { return child === this || this.children.some(node => node.contains(child)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) { this.dispatched.push(event); event.currentTarget = this; for (const callback of this.listeners.get(event.type) ?? []) callback(event); return true; }
    click() { if (this.disabled) return; return [...this.listeners.get("click") ?? []].map(callback => callback({ currentTarget: this })); }
    focus() {}
    closest(selector) { return this.composer ? composer : this.parentElement?.closest(selector) ?? null; }
    getBoundingClientRect() { return { left: 100, top: 600, width: 600, height: 100 }; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      if (selector === "*") return all;
      if (selector.startsWith(".")) return all.filter(node => node.className?.split(" ").includes(selector.slice(1)));
      if (selector === "button") return all.filter(node => node.tagName === "button");
      if (selector.includes("textarea") || selector.includes("textbox")) return all.filter(node => node === editor);
      if (selector.includes("button")) return all.filter(node => node === sendButton);
      return [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    set innerHTML(value) {
      this.html = value;
      this.children = [];
      for (const [tag, name] of [["span", "time"], ["button", "finish"], ["button", "discard"]]) {
        const child = new Element(tag); child.className = "codex-linux-record-replay-" + name; this.appendChild(child);
      }
    }
    get innerHTML() { return this.html ?? ""; }
  }
  class TextArea extends Element { constructor() { super("textarea"); } }
  class Input extends Element {}
  class Event { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  class CustomEvent extends Event { constructor(type, options) { super(type, options); } }
  const documentElement = new Element("html"), head = documentElement.appendChild(new Element("head"));
  const composer = new Element("form"), editor = new TextArea(), sendButton = new Element("button");
  editor.composer = true; sendButton.setAttribute("aria-label", "Send"); sendButton.addEventListener("click", () => sent++);
  composer.appendChild(editor); composer.appendChild(sendButton);
  const documentEvents = new Element("document"), windowEvents = new Element("window");
  const document = {
    documentElement, head, body: documentElement.appendChild(new Element("body")), readyState: loading ? "loading" : "complete",
    createElement: tag => new Element(tag),
    contains: node => documentElement.contains(node),
    getElementById: id => documentElement.querySelectorAll("*").find(node => node.id === id) ?? null,
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  };
  document.body.appendChild(composer);
  const reply = (request, body = {}, extra = {}) => windowEvents.dispatchEvent({ type: "message", data: { type: "fetch-response", responseType: "success", requestId: request.requestId, status: 200, bodyJsonString: JSON.stringify(body), ...extra } });
  const record = payload => {
    if (payload.type !== "fetch") return;
    requests.push(payload);
    if (autoReply) queueMicrotask(() => reply(payload, payload.url.endsWith("linux-record-replay-status") ? { json: status } : { ok: true, json: { ok: true } }));
  };
  const window = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    dispatchEvent(event) { events.push(event); if (!event.__codexForwardedViaBridge) record(event.detail); },
  };
  if (bridge) window.electronBridge = { sendMessageFromView(payload) { record(payload); return Promise.resolve(); } };
  if (preexistingStyle) { const style = new Element("style"); style.id = "codex-linux-record-replay-hud-style"; head.appendChild(style); }
  const context = {
    codexLinuxRecordReplayPendingTranscripts: bootstrap,
    window, document, location: { pathname: detached ? "/detached-window.html" : "/" },
    CustomEvent, Event, InputEvent: Event, KeyboardEvent: Event, HTMLTextAreaElement: TextArea, HTMLInputElement: Input,
    confirm() { confirmations++; return confirmation; },
    Date: class extends Date { constructor(...args) { super(...args.length ? args : [now]); } static now() { return now; } },
    MutationObserver: class { constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); } observe(target) { this.connected = true; this.target = target; } disconnect() { this.connected = false; } },
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, delay) { const id = ++sequence; intervals.set(id, { at: now + delay, callback, delay }); return id; },
    clearInterval: id => intervals.delete(id),
  };
  vm.createContext(context);
  const install = () => vm.runInContext(recordReplayHudRuntimeSource(), context);
  install();
  return {
    context, document, requests, events, timers, intervals, observers, install, reply, editor, sendButton,
    windowListeners: windowEvents.listeners, documentListeners: documentEvents.listeners,
    setStatus(value) { status = value; }, setConfirmation(value) { confirmation = value; },
    get confirmations() { return confirmations; }, get sent() { return sent; }, get now() { return now; },
    hud: () => document.getElementById("codex-linux-record-replay-hud"),
    fire(type, extra = {}) { windowEvents.dispatchEvent({ type, ...extra }); },
    ready() { document.readyState = "complete"; documentEvents.dispatchEvent({ type: "DOMContentLoaded" }); },
    replaceBody() { document.body.remove(); document.body = documentElement.appendChild(new Element("body")); document.body.appendChild(composer); },
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        const due = [...timers].map(([id, timer]) => ({ id, timer, interval: false })).concat([...intervals].map(([id, timer]) => ({ id, timer, interval: true })))
          .filter(row => row.timer.at <= until).sort((a, b) => a.timer.at - b.timer.at)[0];
        if (!due) break;
        now = due.timer.at;
        if (due.interval) due.timer.at += due.timer.delay; else timers.delete(due.id);
        due.timer.callback(); await settleHudPromises();
      }
      now = until; await settleHudPromises();
    },
  };
}

test("UP71 inert detached is silent and main bootstrap polls without recording start", async () => {
  const detached = inertHudRuntime({ detached: true });
  assert.equal(detached.requests.length, 0); assert.equal(detached.intervals.size, 0); assert.equal(detached.timers.size, 0);
  assert.equal(detached.windowListeners.size, 0); assert.equal(detached.observers.length, 0); assert.equal(detached.hud(), null);
  assert.equal(detached.context.codexLinuxRecordReplayCaptureTranscript, undefined);
  const r = inertHudRuntime(); await settleHudPromises(); r.install();
  assert.equal(r.intervals.size, 1); assert.equal(r.windowListeners.get("message").size, 1);
  assert.deepEqual(r.requests.map(request => request.url.split("/").pop()), ["linux-record-replay-status", "linux-record-replay-status"]);
  assert.equal(r.hud().dataset.active, "false"); assert.equal(r.sent, 0);
});

test("UP71 inert recording status survives routes and rebuilds one HUD for replaced body", async () => {
  const r = inertHudRuntime(); await settleHudPromises();
  r.setStatus({ state: "active", session_dir: "/recording", started_at: new Date(r.now - 61000).toISOString() });
  await r.advance(1000);
  assert.equal(r.hud().dataset.active, "true");
  assert.equal(r.hud().querySelector(".codex-linux-record-replay-time").textContent, "1:02");
  const old = r.hud(); r.context.location.pathname = "/conversation/other"; r.replaceBody(); await r.advance(1000);
  assert.notEqual(r.hud(), old); assert.equal(r.hud().dataset.active, "true");
  assert.equal(r.document.documentElement.querySelectorAll(".codex-linux-record-replay-hud").length, 1);
  assert.equal(r.requests.some(request => /stop|cancel|start/.test(request.url)), false);
  for (const state of ["stopped", "canceled", "expired", "idle"]) { r.setStatus({ state }); await r.advance(1000); assert.equal(r.hud().dataset.active, "false", state); }
});

test("UP71 inert pagehide retires owned DOM listeners timers observer and capture API", async () => {
  const r = inertHudRuntime({ autoReply: false });
  r.fire("pagehide");
  assert.equal(r.intervals.size, 0);
  assert.equal(r.timers.size, 0);
  assert.equal([...r.windowListeners.values()].reduce((count, callbacks) => count + callbacks.size, 0), 0);
  assert.equal(r.observers.filter(observer => observer.connected).length, 0);
  assert.equal(r.hud(), null);
  assert.equal(r.context.codexLinuxRecordReplayCaptureTranscript, undefined);
  r.reply(r.requests[0], { json: { state: "active", session_dir: "/recording" } }); await settleHudPromises();
  assert.equal(r.hud(), null);
  assert.equal(r.requests.some(request => /stop|cancel/.test(request.url)), false);
});

async function activeInertHud(options = {}) {
  const runtime = inertHudRuntime(options);
  const active = { state: "active", session_dir: "/recording", started_at: new Date(runtime.now - 60000).toISOString() };
  runtime.setStatus(active);
  if (options.autoReply === false) runtime.reply(runtime.requests[0], { json: active });
  await settleHudPromises();
  if (options.autoReply === false) {
    const snapshot = runtime.requests.find(request => request.url.endsWith("linux-record-replay-desktop-snapshot"));
    if (snapshot) runtime.reply(snapshot, { ok: true, json: { ok: true } });
    await settleHudPromises();
  }
  return runtime;
}

function hudRequests(runtime, method) {
  return runtime.requests.filter(request => request.url.endsWith("/" + method));
}

test("UP71 inert rebuilt HUD keeps deferred Finish controls locked and retires old listeners", async () => {
  const r = await activeInertHud({ autoReply: false });
  const old = r.hud(), oldFinish = old.querySelector(".codex-linux-record-replay-finish");
  const [pending] = oldFinish.click();
  const stop = hudRequests(r, "linux-record-replay-stop-active")[0];
  assert.ok(stop); assert.equal(oldFinish.disabled, true);
  r.replaceBody(); await r.advance(1000);
  const current = r.hud();
  assert.notEqual(current, old);
  assert.equal(oldFinish.listeners.get("click").size, 0);
  assert.equal(current.querySelector(".codex-linux-record-replay-finish").disabled, true);
  assert.equal(r.observers.find(observer => observer.connected).target, r.document.body);
  r.reply(stop, { ok: true, json: { ok: true } }); await settleHudPromises();
  await r.advance(120); await pending;
  assert.equal(current.querySelector(".codex-linux-record-replay-finish").disabled, false);
  assert.equal(r.sent, 1);
  r.fire("pagehide");
});

test("UP71 inert desktop snapshot owns the entire deferred status lookup flight", async () => {
  const r = inertHudRuntime({ autoReply: false });
  r.reply(r.requests[0], { json: { state: "idle" } }); await settleHudPromises();
  const firstLookup = r.requests[1];
  assert.ok(firstLookup.url.endsWith("linux-record-replay-status"));
  await r.advance(1000);
  const poll = r.requests[2];
  r.reply(poll, { json: { state: "idle" } }); await settleHudPromises();
  const active = { state: "active", session_dir: "/recording" };
  r.reply(firstLookup, { json: active }); await settleHudPromises();
  for (const request of r.requests.slice(3).filter(request => request.url.endsWith("linux-record-replay-status"))) r.reply(request, { json: active });
  await settleHudPromises();
  assert.equal(hudRequests(r, "linux-record-replay-desktop-snapshot").length, 1);
  r.fire("pagehide");
});

test("UP71 inert observer follows its replacement body", async () => {
  const r = await activeInertHud();
  r.replaceBody(); await r.advance(1000);
  assert.equal(r.observers.find(observer => observer.connected).target, r.document.body);
  r.fire("pagehide");
});

for (const bridge of [true, false]) {
  test(`UP71 inert Finish is explicit and preserves done-message send flow with bridge=${bridge}`, async () => {
    const r = await activeInertHud({ bridge });
    assert.equal(r.sent, 0);
    assert.equal(r.requests.some(request => /stop-active|cancel-active|record-replay-start/.test(request.url)), false);
    const finish = r.hud().querySelector(".codex-linux-record-replay-finish");
    const [pending] = finish.click();
    assert.equal(finish.disabled, true);
    await settleHudPromises();
    assert.equal(hudRequests(r, "linux-record-replay-stop-active").length, 1);
    assert.equal(r.editor.value, "I'm done recording.");
    await r.advance(120); await pending;
    assert.equal(finish.disabled, false); assert.equal(r.sent, 1);
    assert.equal(hudRequests(r, "linux-record-replay-cancel-active").length, 0);
    assert.equal(r.events.find(event => event.detail?.type === "fetch").__codexForwardedViaBridge === true, bridge);
    for (const request of r.requests) { assert.equal(request.hostId, "local"); assert.equal(request.method, "POST"); assert.match(request.requestId, /^codex-linux-record-replay-/u); }
    r.fire("pagehide");
  });
}

test("UP71 inert Finish keeps Enter fallback and retries stop when neither stop nor submission succeeds", async () => {
  const fallback = await activeInertHud();
  fallback.sendButton.remove();
  const [pending] = fallback.hud().querySelector(".codex-linux-record-replay-finish").click();
  await settleHudPromises(); await fallback.advance(120); await pending;
  assert.deepEqual(fallback.editor.dispatched.filter(event => /key/.test(event.type)).map(event => [event.type, event.key]), [["keydown", "Enter"], ["keyup", "Enter"]]);
  assert.equal(fallback.sent, 0); fallback.fire("pagehide");
  const retry = await activeInertHud({ autoReply: false });
  retry.editor.remove(); retry.sendButton.remove();
  const [failed] = retry.hud().querySelector(".codex-linux-record-replay-finish").click();
  retry.reply(hudRequests(retry, "linux-record-replay-stop-active")[0], { ok: false }); await settleHudPromises();
  assert.equal(hudRequests(retry, "linux-record-replay-stop-active").length, 2);
  retry.reply(hudRequests(retry, "linux-record-replay-stop-active")[1], { ok: true }); await failed;
  assert.equal(retry.sent, 0); assert.equal(retry.hud().querySelector(".codex-linux-record-replay-finish").disabled, false);
  retry.fire("pagehide");
});

test("UP71 inert Discard confirms explicit cancellation and restores controls after an error", async () => {
  const r = await activeInertHud({ autoReply: false });
  const discard = r.hud().querySelector(".codex-linux-record-replay-discard");
  r.setConfirmation(false); await Promise.all(discard.click());
  assert.equal(r.confirmations, 1); assert.equal(hudRequests(r, "linux-record-replay-cancel-active").length, 0);
  r.setConfirmation(true); const [pending] = discard.click();
  assert.equal(discard.disabled, true); assert.equal(r.confirmations, 2);
  const cancel = hudRequests(r, "linux-record-replay-cancel-active")[0];
  assert.deepEqual(JSON.parse(cancel.body), { discarded: true });
  r.reply(cancel, null, { responseType: "error", error: "inert cancellation failure" }); await pending;
  assert.equal(discard.disabled, false); assert.equal(r.sent, 0);
  assert.equal(hudRequests(r, "linux-record-replay-stop-active").length, 0);
  r.fire("pagehide");
});

test("UP71 inert status error hides HUD and reconnect restores the global active recording", async () => {
  const r = await activeInertHud({ autoReply: false });
  await r.advance(1000);
  r.reply(hudRequests(r, "linux-record-replay-status").at(-1), null, { responseType: "error", error: "inert disconnected bridge" }); await settleHudPromises();
  assert.equal(r.hud().dataset.active, "false");
  await r.advance(1000);
  r.reply(hudRequests(r, "linux-record-replay-status").at(-1), { json: { state: "active", session_dir: "/recording" } }); await settleHudPromises();
  assert.equal(r.hud().dataset.active, "true");
  assert.equal(r.requests.some(request => /stop-active|cancel-active|record-replay-start/.test(request.url)), false);
  assert.equal(r.sent, 0); r.fire("pagehide");
});

test("UP71 inert snapshot cadence remains five seconds and pending snapshots remain single-flight", async () => {
  const r = await activeInertHud();
  assert.equal(hudRequests(r, "linux-record-replay-desktop-snapshot").length, 1);
  await r.advance(4999); assert.equal(hudRequests(r, "linux-record-replay-desktop-snapshot").length, 1);
  await r.advance(1); assert.equal(hudRequests(r, "linux-record-replay-desktop-snapshot").length, 2);
  assert.deepEqual(JSON.parse(hudRequests(r, "linux-record-replay-desktop-snapshot")[0].body), { sessionDir: "/recording", source: "record-replay-hud" });
  r.fire("pagehide");
  const held = inertHudRuntime({ autoReply: false });
  const active = { state: "active", session_dir: "/recording" };
  held.reply(held.requests[0], { json: active }); await settleHudPromises();
  const first = hudRequests(held, "linux-record-replay-desktop-snapshot")[0];
  for (let second = 0; second < 6; second++) { await held.advance(1000); held.reply(hudRequests(held, "linux-record-replay-status").at(-1), { json: active }); await settleHudPromises(); }
  assert.equal(hudRequests(held, "linux-record-replay-desktop-snapshot").length, 1);
  held.reply(first, { ok: true }); await settleHudPromises();
  await held.advance(1000); held.reply(hudRequests(held, "linux-record-replay-status").at(-1), { json: active }); await settleHudPromises();
  assert.equal(hudRequests(held, "linux-record-replay-desktop-snapshot").length, 2);
  held.fire("pagehide");
});

test("UP71 inert transcript normalization and dedup retain session action text and captured cap 120", async () => {
  const r = await activeInertHud();
  const capture = r.context.codexLinuxRecordReplayCaptureTranscript;
  await capture(" hello \n world ", "send"); await capture("hello world", "send");
  assert.equal(hudRequests(r, "linux-record-replay-speech-context").length, 1);
  assert.deepEqual(JSON.parse(hudRequests(r, "linux-record-replay-speech-context")[0].body), { sessionDir: "/recording", transcript: "hello world", source: "codex-dictation-send" });
  await capture("hello world", "insert");
  assert.equal(hudRequests(r, "linux-record-replay-speech-context").length, 2);
  assert.equal(await capture("hello world", "discard"), false);
  for (let index = 0; index < 121; index++) await capture("entry " + index, "send");
  const before = hudRequests(r, "linux-record-replay-speech-context").length;
  await capture("entry 120", "send"); assert.equal(hudRequests(r, "linux-record-replay-speech-context").length, before);
  await capture("entry 0", "send"); assert.equal(hudRequests(r, "linux-record-replay-speech-context").length, before + 1);
  r.setStatus({ state: "active", session_dir: "/second-recording" }); await r.advance(1000);
  await capture("entry 120", "send");
  assert.equal(JSON.parse(hudRequests(r, "linux-record-replay-speech-context").at(-1).body).sessionDir, "/second-recording");
  r.fire("pagehide");
});

for (const origin of ["bootstrap", "capture-api"]) {
  test(`UP71 inert pending transcript queue keeps the newest 60 from ${origin}`, async () => {
    const entries = Array.from({ length: 65 }, (_, index) => ({ transcript: "queued " + index, action: "send", queuedAt: 1_000_000 }));
    const r = inertHudRuntime({ bootstrap: origin === "bootstrap" ? entries : [] });
    await settleHudPromises(800);
    if (origin === "capture-api") for (const entry of entries) await r.context.codexLinuxRecordReplayCaptureTranscript(entry.transcript, entry.action);
    r.setStatus({ state: "active", session_dir: "/recording" }); await r.advance(1000); await settleHudPromises(800);
    const spoken = hudRequests(r, "linux-record-replay-speech-context").map(request => JSON.parse(request.body).transcript);
    assert.equal(spoken.length, 60); assert.equal(spoken[0], "queued 5"); assert.equal(spoken.at(-1), "queued 64");
    assert.equal(r.context.codexLinuxRecordReplayPendingTranscripts.length, 0);
    r.fire("pagehide");
  });
}

test("UP71 inert pending transcript age and attempts drop policies preserve their boundaries", async () => {
  const age = inertHudRuntime({ bootstrap: [{ transcript: "old", action: "send", queuedAt: 399999 }, { transcript: "edge", action: "send", queuedAt: 400000 }] });
  age.setStatus({ state: "active", session_dir: "/recording" }); await settleHudPromises(100);
  assert.deepEqual(hudRequests(age, "linux-record-replay-speech-context").map(request => JSON.parse(request.body).transcript), ["edge"]);
  age.fire("pagehide");
  for (const attempts of [24, 25]) {
    const r = inertHudRuntime(); await settleHudPromises();
    await r.context.codexLinuxRecordReplayCaptureTranscript("retry item", "send");
    await r.advance(attempts * 1000);
    r.setStatus({ state: "active", session_dir: "/recording" }); await r.advance(1000);
    assert.equal(hudRequests(r, "linux-record-replay-speech-context").length, attempts === 24 ? 1 : 0, "attempts=" + attempts);
    r.fire("pagehide");
  }
});

test("UP71 inert DOM-ready start and cleanup preserve unrelated resources and settle deferred Finish", async () => {
  const loading = inertHudRuntime({ loading: true });
  assert.equal(loading.intervals.size, 0); assert.equal(loading.hud(), null);
  loading.ready(); loading.ready(); await settleHudPromises();
  assert.equal(loading.intervals.size, 1); assert.equal(loading.observers.length, 1);
  loading.fire("pagehide");
  const abandoned = inertHudRuntime({ loading: true }); abandoned.fire("pagehide"); abandoned.ready();
  assert.equal(abandoned.intervals.size, 0); assert.equal(abandoned.hud(), null);
  const r = await activeInertHud({ preexistingStyle: true });
  const foreignStyle = r.document.getElementById("codex-linux-record-replay-hud-style");
  const foreignListener = () => {}, foreignCapture = () => "foreign";
  r.windowListeners.get("message").add(foreignListener);
  const capture = r.context.codexLinuxRecordReplayCaptureTranscript;
  const [pending] = r.hud().querySelector(".codex-linux-record-replay-finish").click(); await settleHudPromises();
  r.context.codexLinuxRecordReplayCaptureTranscript = foreignCapture;
  r.fire("pagehide"); await pending;
  assert.equal(r.document.getElementById("codex-linux-record-replay-hud-style"), foreignStyle);
  assert.equal(r.context.codexLinuxRecordReplayCaptureTranscript, foreignCapture);
  assert.deepEqual([...r.windowListeners.get("message")], [foreignListener]);
  assert.equal(await capture("late", "send"), false);
  assert.equal(r.sent, 0); assert.equal(r.timers.size, 0); assert.equal(r.intervals.size, 0); assert.equal(r.hud(), null);
});

test("UP71 HUD descriptor includes orphan DOM and style definitions in physical inventory", t => {
  for (const source of [
    'const style=document.createElement("style");style.id="codex-linux-record-replay-hud-style";',
    'const root=document.createElement("div");root.id="codex-linux-record-replay-hud";',
    'const root=document.createElement("div");root.className="codex-linux-record-replay-hud";',
    'const root=document.createElement("div");root["id"]="codex-linux-record-replay-hud";',
    'const root=document.createElement("div");root.setAttribute("id","codex-linux-record-replay-hud");',
  ]) {
    const fixture = hudAppFixture(t);
    fs.writeFileSync(path.join(fixture.assets, "orphan.js"), source);
    const bytes = hudFixtureBytes(fixture), oldWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", source); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(writes, 0); assertHudFixtureBytes(fixture, bytes);
  }
});

function ordinaryDictationFixture(t, { copies = 2, dependency = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-replay-ordinary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets"); fs.mkdirSync(assets, { recursive: true });
  const names = Array.from({ length: copies }, (_, index) => index === 0 ? "primary.js" : "peer.js");
  const prefix = dependency ? 'import*as dependency from"./dependency.js";' : "";
  for (const name of names) fs.writeFileSync(path.join(assets, name), prefix + currentComposerTranscriptFixture());
  if (dependency) fs.writeFileSync(path.join(assets, "dependency.js"), 'export const opaque={nativeData:true};');
  const descriptor = descriptors.find(item => item.id === "record-replay-dictation-transcript");
  const selected = normalizePatchDescriptors([{ ...descriptor, featureId: "record-and-replay", sourceKind: "feature" }]);
  return { root, assets, names, run() {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
    return report.patches[0];
  } };
}

function ordinaryDictationBytes(fixture) {
  return Object.fromEntries(fs.readdirSync(fixture.assets).filter(name => fs.lstatSync(path.join(fixture.assets, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(fixture.assets, name), "utf8")]));
}

function assertOrdinaryDictationBytes(fixture, expected) {
  for (const [name, bytes] of Object.entries(expected)) assert.equal(fs.readFileSync(path.join(fixture.assets, name), "utf8"), bytes, name);
}

function assertOrdinaryRefusal(t, mutate, label) {
  const raw = currentComposerTranscriptFixture(), source = mutate(raw);
  const direct = captureWarns(() => applyRecordReplayDictationTranscriptPatch(source));
  assert.equal(direct.value, source, label); assert.equal(direct.warnings.length, 1, label);
  const fixture = ordinaryDictationFixture(t);
  for (const name of fixture.names) fs.writeFileSync(path.join(fixture.assets, name), source);
  const before = ordinaryDictationBytes(fixture), oldWrite = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
  try { assert.equal(fixture.run().status, "skipped-optional", label); }
  finally { fs.writeFileSync = oldWrite; }
  assert.equal(writes, 0, label); assertOrdinaryDictationBytes(fixture, before);
}

test("UP72 descriptor commits all current native copies and unchanged static read dependencies", t => {
  const fixture = ordinaryDictationFixture(t, { dependency: true });
  const before = ordinaryDictationBytes(fixture);
  const descriptor = descriptors.find(item => item.id === "record-replay-dictation-transcript");
  assert.equal(descriptor.phase, "extracted-app:pre-webview"); assert.equal(descriptor.order, 20695);
  assert.equal(fixture.run().status, "applied"); assert.equal(fixture.run().status, "already-applied");
  for (const name of fixture.names) {
    const patched = fs.readFileSync(path.join(fixture.assets, name), "utf8");
    const seam = before[name].indexOf('if(text.length>0||null!=context){') + 'if(text.length>0||null!=context){'.length;
    const contributionLength = patched.length - before[name].length;
    assert.ok(contributionLength > 0);
    assert.equal(patched.slice(0, seam) + patched.slice(seam + contributionLength), before[name]);
    assert.equal(patched.split('codexLinuxRecordReplayCaptureTranscript?.(').length - 1, 1);
  }
  assert.equal(fs.readFileSync(path.join(fixture.assets, "dependency.js"), "utf8"), before['dependency.js']);
});

test("UP72 canonical contribution validates both direct and queued dataflow", t => {
  for (const [from, to] of [
    ['CaptureTranscript?.(text,action.action)', 'CaptureTranscript?.(other,action.action)'],
    ['CaptureTranscript?.(text,action.action)', 'CaptureTranscript?.(text,other.action)'],
    ['transcript:text,action:action.action,queuedAt:', 'transcript:"wrong",action:action.action,queuedAt:'],
    ['transcript:text,action:action.action,queuedAt:', 'transcript:text,action:"wrong",queuedAt:'],
    ['codexLinuxRecordReplayPendingTranscripts??=[]', 'otherQueue??=[]'],
    ['queuedAt:Date.now()', 'queuedAt:0'],
    ['codexLinuxRecordReplayCaptureResult?.catch?.(()=>{})', 'codexLinuxRecordReplayCaptureResult?.catch?.(other)'],
    ['catch{return!1}', 'catch{throw Error("wrong policy")}'],
  ]) assertOrdinaryRefusal(t, raw => applyRecordReplayDictationTranscriptPatch(raw).replace(from, to), from);
});

test("UP72 native publication import and callback ABI drifts refuse before writes", t => {
  for (const [from, to] of [
    ['dictate:()=>hook', 'dictate:()=>other'],
    ['load.d(exports,', 'other.d(exports,'],
    ['var historyNS=load("History")', 'var historyNS=other("History")'],
    ['let invoke=callback;', 'let invoke=other;'],
    ['await invoke({...request,analytics:analytics},!0)', 'await other({...request,analytics:analytics},!0)'],
    ['await invoke({...request,analytics:analytics},!0)', 'invoke({...request,analytics:analytics},!0)'],
    ['handlers:handlers,language:language', 'newhandlers:handlers,language:language'],
    ['return await (async()=>{try{', 'return (async()=>{try{'],
    ['cleanupEnabled:cleanupEnabled,signal:action.abortController.signal', 'cleanupEnabled:other,signal:action.abortController.signal'],
    ['action.isCurrent?.()===!1&&action.abortController.abort()', 'other.isCurrent?.()===!1&&action.abortController.abort()'],
    ['signal:action.abortController.signal,response:response', 'signal:other.signal,response:response'],
    ['dictationSessionId:analytics.dictationSessionId', 'dictationSessionId:other.dictationSessionId'],
    ['history?.setTranscript(text,void 0)', 'history?.setTranscript(other,void 0)'],
    ['handlers.onTranscriptSend(text,session,context)', 'handlers.onTranscriptSend(text,session,other)'],
    ['pending.current===action&&"send"===pending.current.action', 'other.current===action&&"send"===pending.current.action'],
    ['request.signal?.removeEventListener("abort",abort)', 'request.signal?.removeEventListener("abort",other)'],
  ]) assertOrdinaryRefusal(t, raw => raw.replace(from, to), from);
});

test("UP72 publication projection preserves later writes and permits real local shadows", t => {
  const inject = (source, text) => source.replace('function hook(props){', text + 'function hook(props){');
  for (const statement of [
    'historyNS=other;', 'function rebind(){historyNS<<=1;}', 'function rebind(){\\u0068istoryNS=other;}',
    'function rebind(){hook=other;}', 'for(let historyNS of [])for(let item of []){historyNS=item;}historyNS=other;',
  ]) assertOrdinaryRefusal(t, raw => inject(raw, statement), statement);
  for (const statement of [
    'function local(historyNS){historyNS=other;}',
    'for(let historyNS of [])for(let item of []){historyNS=item;}',
    'scope:{let historyNS;historyNS=other;break scope;}',
    'function local(){let historyNS;historyNS>>>=1;}',
    'const opaque={nativeData:"codexLinuxRecordReplayCaptureTranscript?.(wrong,wrong)"};',
    '/*codexLinuxRecordReplayPendingTranscripts??=[]).push({transcript:wrong})*/',
  ]) {
    const raw = inject(currentComposerTranscriptFixture(), statement), output = captureWarns(() => applyRecordReplayDictationTranscriptPatch(raw));
    assert.notEqual(output.value, raw, statement); assert.equal(output.warnings.length, 0, statement);
    assert.equal(applyRecordReplayDictationTranscriptPatch(output.value), output.value, statement);
  }
});

test("UP72 renamed native roles opaque context data and UTF16 preimages survive", t => {
  const fixture = ordinaryDictationFixture(t);
  for (const name of fixture.names) {
    const text = 'const opaque="😀";' + currentComposerTranscriptFixture()
      .replace(/\btext\b/gu, "sanitizedText").replace(/\baction\b/gu, "nextAction")
      .replace(/\bhistoryNS\b/gu, "nativeHistory").replace('attemptId:analytics.attemptId,', 'attemptId:analytics.attemptId,nativeOpaque:{label:"preserve"},');
    // Renaming JavaScript property keys would change the native ABI.
    const corrected = text.replace(/sanitizedText:/gu, "text:").replace(/\.sanitizedText\b/gu, ".text")
      .replace(/nextAction:/gu, "action:").replace(/\.nextAction\b/gu, ".action");
    fs.writeFileSync(path.join(fixture.assets, name), corrected);
  }
  assert.equal(fixture.run().status, "applied"); assert.equal(fixture.run().status, "already-applied");
  for (const name of fixture.names) assert.ok(fs.readFileSync(path.join(fixture.assets, name), "utf8").includes('nativeOpaque:{label:"preserve"}'));
});

test("UP72 mixed malformed and hidden physical peers and orphan contributions refuse atomically", t => {
  for (const kind of ["mixed", "malformed-peer", "hidden-peer", "orphan-call", "orphan-queue", "orphan-unicode", "duplicate", "module-duplicate"]) {
    const fixture = ordinaryDictationFixture(t), raw = currentComposerTranscriptFixture();
    if (kind === "mixed") fs.writeFileSync(path.join(fixture.assets, "primary.js"), applyRecordReplayDictationTranscriptPatch(raw));
    else if (kind === "malformed-peer") fs.writeFileSync(path.join(fixture.assets, "peer.js"), raw.replace('dictate:()=>hook', 'dictate:()=>other'));
    else if (kind === "hidden-peer") { fs.renameSync(path.join(fixture.assets, "peer.js"), path.join(fixture.assets, "peer.mjs")); fs.writeFileSync(path.join(fixture.assets, "peer.mjs"), raw.replace('global-dictation-record-history-item', 'hidden-native-history')); }
    else if (kind === "orphan-call") fs.writeFileSync(path.join(fixture.assets, "orphan.js"), 'globalThis.codexLinuxRecordReplayCaptureTranscript?.("x","send");');
    else if (kind === "orphan-queue") fs.writeFileSync(path.join(fixture.assets, "orphan.js"), '(globalThis.codexLinuxRecordReplayPendingTranscripts??=[]).push({transcript:"x",action:"send",queuedAt:0});');
    else if (kind === "orphan-unicode") fs.writeFileSync(path.join(fixture.assets, "orphan.js"), 'globalThis["\\u0063odexLinuxRecordReplayCaptureTranscript"]?.("x","send");');
    else if (kind === "duplicate") {
      const patched = applyRecordReplayDictationTranscriptPatch(raw), seam = raw.indexOf('if(text.length>0||null!=context){') + 'if(text.length>0||null!=context){'.length;
      const contribution = patched.slice(seam, seam + patched.length - raw.length);
      fs.writeFileSync(path.join(fixture.assets, "primary.js"), patched.slice(0, seam) + contribution + patched.slice(seam));
    } else fs.writeFileSync(path.join(fixture.assets, "primary.js"), raw.replace('Opaque(module,exports,load){', 'Composer(module,exports,load){'));
    const before = ordinaryDictationBytes(fixture), oldWrite = fs.writeFileSync; let writes = 0;
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(writes, 0, kind); assertOrdinaryDictationBytes(fixture, before);
  }
});

test("UP72 commit protects unchanged dependencies inventory races and partial writes", t => {
  for (const kind of ["partial", "dependency", "inventory"]) {
    const fixture = ordinaryDictationFixture(t, { dependency: true }), before = ordinaryDictationBytes(fixture), oldWrite = fs.writeFileSync;
    let attempted = false;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (String(file).endsWith("/primary.js") && !attempted) {
        attempted = true;
        if (kind === "partial") { oldWrite(file, "partial"); throw Error("inert partial write"); }
        if (kind === "dependency") oldWrite(path.join(fixture.assets, "dependency.js"), before['dependency.js'] + "\n// concurrent");
        else oldWrite(path.join(fixture.assets, "hidden.js"), 'globalThis.codexLinuxRecordReplayCaptureTranscript?.("x","send");');
      }
      return oldWrite(file, bytes, ...options);
    };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(attempted, true, kind);
    for (const name of fixture.names) assert.equal(fs.readFileSync(path.join(fixture.assets, name), "utf8"), before[name], name);
  }
});

test("UP72 failed restoration remains fatal", t => {
  const fixture = ordinaryDictationFixture(t), oldWrite = fs.writeFileSync; let attempts = 0;
  fs.writeFileSync = (file, bytes, ...options) => {
    if (String(file).endsWith("/primary.js")) { if (++attempts === 1) oldWrite(file, "partial"); throw Error("inert restoration failure"); }
    return oldWrite(file, bytes, ...options);
  };
  try { assert.throws(() => fixture.run(), /rollback could not restore original bytes/u); }
  finally { fs.writeFileSync = oldWrite; }
  assert.equal(attempts, 2);
});

test("UP72 warm canonical checks revalidate inventory and read dependencies after preflight", t => {
  for (const kind of ["inventory", "dependency"]) {
    const fixture = ordinaryDictationFixture(t, { dependency: true });
    assert.equal(fixture.run().status, "applied");
    const oldRead = fs.readFileSync, oldWrite = fs.writeFileSync; let changed = false, writes = 0;
    fs.readFileSync = (file, ...options) => {
      const bytes = oldRead(file, ...options);
      if (!changed && options.length === 0 && String(file).endsWith("/primary.js")) {
        changed = true;
        if (kind === "inventory") oldWrite(path.join(fixture.assets, "hidden.js"), 'globalThis.codexLinuxRecordReplayCaptureTranscript?.("x","send");');
        else oldWrite(path.join(fixture.assets, "dependency.js"), 'export const opaque={concurrent:true};');
      }
      return bytes;
    };
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.readFileSync = oldRead; fs.writeFileSync = oldWrite; }
    assert.equal(changed, true); assert.equal(writes, 0);
  }
});

test("UP72 inert direct and queued capture carry the same sanitized native transcript and action", async () => {
  const raw = currentComposerTranscriptFixture(), patched = applyRecordReplayDictationTranscriptPatch(raw);
  for (const action of ["send", "insert"]) {
    const direct = composerCallbackRuntime(patched, { action, capture: () => true });
    const queued = composerCallbackRuntime(patched, { action });
    await direct.run(); await queued.run();
    assert.deepEqual(direct.events.find(event => event[0] === "capture"), ["capture", "cleaned transcript", action]);
    assert.deepEqual(JSON.parse(JSON.stringify(queued.globals.codexLinuxRecordReplayPendingTranscripts)), [{ transcript: "cleaned transcript", action, queuedAt: 1234 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(direct.events.filter(event => event[0] !== "capture"))), JSON.parse(JSON.stringify(queued.events)));
    const captureAt = direct.events.findIndex(event => event[0] === "capture"), historyAt = direct.events.findIndex(event => event[0] === "history");
    assert.ok(direct.events.findIndex(event => event[0] === "cleanup") < captureAt);
    assert.ok(captureAt < historyAt);
  }
});

test("UP72 inert synthetic capture faults stay isolated and deferred work never blocks native send", async () => {
  const patched = applyRecordReplayDictationTranscriptPatch(currentComposerTranscriptFixture());
  for (const capture of [() => { throw Error("synthetic capture failure"); }, () => Promise.reject(Error("synthetic capture rejection")), () => new Promise(() => {})]) {
    const runtime = composerCallbackRuntime(patched, { capture });
    let done = false;
    const pending = runtime.run().then(() => { done = true; });
    await settleHudPromises(80);
    assert.equal(done, true); await pending;
    assert.equal(runtime.events.filter(event => event[0] === "send").length, 1);
    assert.equal(runtime.events.filter(event => event[0] === "capture").length, 1);
    assert.equal(runtime.globals.codexLinuxRecordReplayPendingTranscripts, undefined);
  }
});

test("UP72 inert native history send and cleanup failures retain original propagation", async () => {
  const raw = currentComposerTranscriptFixture(), patched = applyRecordReplayDictationTranscriptPatch(raw);
  for (const options of [{ historyError: true }, { nativeError: true }, { cleanupError: true }]) {
    for (const source of [raw, patched]) {
      const runtime = composerCallbackRuntime(source, { ...options, capture: () => true });
      await assert.rejects(runtime.run(), /native (?:history|send|cleanup) failure/u);
      if (options.cleanupError) assert.equal(runtime.events.some(event => event[0] === "capture"), false);
    }
  }
});

test("UP72 inert empty abort and stale-current paths preserve native cancellation gates", async () => {
  const raw = currentComposerTranscriptFixture(), patched = applyRecordReplayDictationTranscriptPatch(raw);
  for (const options of [{ cleaned: "" }, { abortAt: "asr" }, { abortAt: "cleanup" }, { stale: true }]) {
    const baseline = composerCallbackRuntime(raw, options), runtime = composerCallbackRuntime(patched, { ...options, capture: () => true });
    await baseline.run(); await runtime.run();
    assert.equal(runtime.events.some(event => event[0] === "capture"), false);
    assert.equal(runtime.events.some(event => event[0] === "send" || event[0] === "insert"), false);
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.events)), JSON.parse(JSON.stringify(baseline.events)));
  }
});

test("UP72 inert recovery native session and recording context arguments are preserved", async () => {
  const patched = applyRecordReplayDictationTranscriptPatch(currentComposerTranscriptFixture());
  const recovery = composerCallbackRuntime(patched, { recovery: true, retrying: true, capture: () => true });
  await recovery.run();
  assert.equal(recovery.events.filter(event => event[0] === "retry").length, 1);
  assert.equal(recovery.events.filter(event => event[0] === "send" || event[0] === "insert").length, 0);
  for (const options of [{ recording: true }, { chatgpt: {} }]) {
    const runtime = composerCallbackRuntime(patched, { ...options, capture: () => true });
    await runtime.run();
    const sent = runtime.events.find(event => event[0] === "send");
    assert.equal(sent[2], "native-session");
    assert.equal(sent.length, 4);
    const context = sent[3];
    assert.equal(context.dictationSessionId, "dictation-session"); assert.equal(context.attemptId, "attempt");
    assert.equal(context.recording, options.recording ? runtime.request.audio : undefined);
    assert.equal(context.recordingSignal, runtime.request.recordingSignal);
    assert.equal(context.recordingDurationMs, 500); assert.equal(context.transcriptReceivedTs, 1234);
    assert.equal(runtime.events.find(event => event[0] === "capture")[1], options.chatgpt ? " raw transcript " : "cleaned transcript");
  }
});

test("UP72 inert pending insert-to-send changes keep the original final empty native submission", async () => {
  const patched = applyRecordReplayDictationTranscriptPatch(currentComposerTranscriptFixture());
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  const runtime = composerCallbackRuntime(patched, { action: "insert", nativeDeferred: deferred, capture: () => true });
  const pending = runtime.run(); await settleHudPromises(80);
  assert.equal(runtime.events.filter(event => event[0] === "insert").length, 1);
  runtime.pending.current.action = "send"; resolve(); await pending;
  assert.deepEqual(runtime.events.filter(event => ["capture", "insert", "send"].includes(event[0])), [
    ["capture", "cleaned transcript", "insert"], ["insert", "cleaned transcript", "native-session"], ["send", "", "native-session"],
  ]);
});

test("UP72 inert direct API status delay is unawaited and queued fallback is consumed by unchanged UP71", async () => {
  const patched = applyRecordReplayDictationTranscriptPatch(currentComposerTranscriptFixture());
  const delayed = inertHudRuntime({ autoReply: false });
  const runtime = composerCallbackRuntime(patched, { now: delayed.now, capture: delayed.context.codexLinuxRecordReplayCaptureTranscript });
  await runtime.run();
  assert.equal(runtime.events.filter(event => event[0] === "send").length, 1);
  assert.ok(delayed.requests.filter(request => request.url.endsWith("linux-record-replay-status")).length >= 2);
  assert.equal(delayed.requests.some(request => request.url.endsWith("linux-record-replay-speech-context")), false);
  delayed.fire("pagehide"); await settleHudPromises();
  const hud = inertHudRuntime(); await settleHudPromises();
  const queued = composerCallbackRuntime(patched, { now: hud.now }); await queued.run();
  hud.context.codexLinuxRecordReplayPendingTranscripts = queued.globals.codexLinuxRecordReplayPendingTranscripts;
  hud.setStatus({ state: "active", session_dir: "/recording" }); await hud.advance(1000); await settleHudPromises(120);
  const spoken = hudRequests(hud, "linux-record-replay-speech-context");
  assert.equal(spoken.length, 1);
  assert.deepEqual(JSON.parse(spoken[0].body), { sessionDir: "/recording", transcript: "cleaned transcript", source: "codex-dictation-send" });
  hud.fire("pagehide");
});

test("UP72 inert discard and blank context preserve unchanged UP71 filtering", async () => {
  const patched = applyRecordReplayDictationTranscriptPatch(currentComposerTranscriptFixture());
  const hud = await activeInertHud();
  for (const options of [{ action: "discard" }, { text: "", chatgpt: {} }]) {
    const runtime = composerCallbackRuntime(patched, { ...options, now: hud.now, capture: hud.context.codexLinuxRecordReplayCaptureTranscript });
    await runtime.run(); await settleHudPromises();
    assert.equal(hudRequests(hud, "linux-record-replay-speech-context").length, 0);
    assert.equal(runtime.events.filter(event => event[0] === "capture").length, 1);
  }
  hud.fire("pagehide");
});

test("UP72 injected capture capabilities keep their selected lexical scope", t => {
  for (const [from, to] of [
    ['export const __rspack_esm_ids=', 'const Date={};export const __rspack_esm_ids='],
    ['function hook(props){', 'const globalThis={};function hook(props){'],
    ['function hook(props){', 'function hook(props){let Date;'],
    ['let response=await (', 'let globalThis;let response=await ('],
  ]) assertOrdinaryRefusal(t, raw => raw.replace(from, to), from);
  const raw = currentComposerTranscriptFixture().replace('function hook(props){', 'function opaque(){let Date;let globalThis;}function hook(props){');
  assert.notEqual(applyRecordReplayDictationTranscriptPatch(raw), raw);
});
