#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
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
  applyRecordReplayPluginGatePatch,
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

const featureDir = __dirname;

function currentComposerTranscriptFixture() {
  return "async function send(){let p=`Create an image of a neon cabin`,c={setTranscript(){}},a={dictationSessionId:`session-1`,performance:{mark(){}}},i={action:`send`,recovery:null},s={chatgpt:null,onRecoveryChange:null,onTranscriptRetry:async()=>{},onTranscriptSend:async(t,e)=>globalThis.events.push([`send`,t,e]),onTranscriptInsert:async(t,e)=>globalThis.events.push([`insert`,t,e]),onTranscriptCancel:()=>globalThis.events.push([`cancel`])},x=null,te={current:i};if(p.length>0||s.chatgpt!=null){c==null&&s.chatgpt==null?une.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:p}):c?.setTranscript(p),a.performance.mark(`transcript_dispatched`);let e=c==null?void 0:a.dictationSessionId;if(i.recovery!=null&&s.onRecoveryChange!=null){await s.onTranscriptRetry?.(p,e,x)}else if(i.action===`send`){let t=x==null?s.onTranscriptSend(p,e):s.onTranscriptSend(p,e,x);await t}else{let t=x==null?s.onTranscriptInsert(p,e):s.onTranscriptInsert(p,e,x);await t,te.current===i&&te.current.action===`send`&&await s.onTranscriptSend(``,e,x)}}else s.onTranscriptCancel?.()}";
}

function retiredChronicleControllerFixture() {
  return [
    "var Base={Tf:class{}};",
    "var Hse=class{dependencies;pendingStatus=null;constructor(e){this.dependencies=e}status(){return this.pendingStatus??=this.request(`skysightStatus`).finally(()=>{this.pendingStatus=null}),this.pendingStatus}enable(){return this.request(`skysightStart`)}pause(e){return this.requestPauseResume(`skysightPause`,e)}resume(){return this.requestPauseResume(`skysightResume`)}getSettings(){return this.dependencies.request({method:`skysightGetSettings`,params:{}})}updateSettings(e){return this.dependencies.request({method:`skysightUpdateSettings`,params:{settings:e}})}clearHistory(e,t){return this.dependencies.request({method:`skysightClearHistory`,params:{interval:t,scope:e}})}requestPauseResume(e,t){return this.dependencies.request({method:e,params:t==null?{}:{duration:t}})}request(e){return this.dependencies.request({method:e,params:{}})}async stopRecorder(){let e=await this.request(`skysightStop`);return e}};",
    "var $O=class extends Base.Tf{constructor(e,t,n,r,i,a){super(),this.appServerConnection=e,this.getController=t,this.isEligible=n,this.loadApplications=r,this.loadApplicationsByBundleIdentifier=i,this.history=a}async getState(){return this.getController().status()}async setEnabled(e){return e?this.appServerConnection.enableSkysightChronicle():this.getController().stopRecorder()}async pause(){return this.getController().pause()}async resume(){return this.appServerConnection.resumeChronicleSidecar()}async getSettings(){return this.getController().getSettings()}async updateSettings(e){return this.getController().updateSettings(e)}async listApplications(){return this.isEligible(),this.loadApplications()}async resolveApplications(e){return this.isEligible(),this.loadApplicationsByBundleIdentifier(e)}async listHistory(){return this.isEligible(),this.history.list()}async listHistorySuggestions(){return this.isEligible(),this.history.listSuggestions()}async listHistorySummaryIntervals({sinceMs:e}){return this.isEligible(),this.history.listSummaryIntervals(e)}async clearHistory(e,t){await this.getController().clearHistory(e,t)}};",
    "function Cr(){return{skysight:false}}let N=process.platform===`darwin`,xe;var Ce={requestComputerUseWorker(){}},Xe={reconcileComputerHistoryPluginInstallation(){}},U={broadcastQueryCacheInvalidation(){}},V={codexHome:`/tmp`};async function archive(e){return e}",
    "N&&(xe=new Hse({request:Ce.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:e=>{Xe.reconcileComputerHistoryPluginInstallation(e)},archiveLegacyChronicleSkill:async()=>{await archive({codexHome:V.codexHome,reason:`skysight_gate_enabled`})&&U.broadcastQueryCacheInvalidation([`skills`])}}));",
    "var appOptions={getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null};",
    "var Host=class{constructor(){this.options=appOptions;let i={};this.services={chronicle:process.platform===`darwin`&&this.options.getSkysightRecorderController!=null?new $O(i,this.options.getSkysightRecorderController,()=>Cr().skysight,()=>[],()=>[],{}):void 0}}};",
    'var bridge={"get-global-state":async({key:e})=>null};',
  ].join("");
}

function currentChronicleControllerFixture() {
  return [
    "var Base={Tf:class{}};",
    "var Hse=class{dependencies;cachedStatus={state:`stopped`};desiredState=`stopped`;pendingOperation=Promise.resolve();finishPendingPauseResume=null;pendingStatus=null;constructor(e){this.dependencies=e}shouldReconcileAfterServiceRespawn(){return this.desiredState===`running`}status(){return this.pendingStatus??=this.request(`skysightStatus`).then(e=>(e.state===`stopped`&&this.finishPendingPauseResume?.(e),e)).finally(()=>{this.pendingStatus=null}),this.pendingStatus}enable(){return this.desiredState=`running`,this.runSerialized(()=>this.withFailedEnableRollback(async()=>this.request(`skysightStart`)))}pause(e){return this.requestPauseResume(`skysightPause`,e)}resume(){return this.requestPauseResume(`skysightResume`)}getSettings(){return this.dependencies.request({method:`skysightGetSettings`,params:{}})}updateSettings(e){return this.dependencies.request({method:`skysightUpdateSettings`,params:{settings:e}})}clearHistory(e,t){return this.dependencies.request({method:`skysightClearHistory`,params:{interval:t,scope:e}})}requestPauseResume(e,t){return new Promise((n,r)=>{this.finishPendingPauseResume=n,this.dependencies.request({method:e,params:t==null?{}:{duration:t}}).then(n,r)}).finally(()=>{this.finishPendingPauseResume=null})}request(e){return this.dependencies.request({method:e,params:{}})}async withFailedEnableRollback(e){try{return await e()}catch(e){try{await this.stopRecorder()}catch(t){throw AggregateError([e,t],`Failed to enable Chronicle and stop the recorder during rollback`)}throw e}}async stopRecorder(){let e=await this.request(`skysightStop`);return e}runSerialized(e){let t=this.pendingOperation.then(e,e);return this.pendingOperation=t.then(()=>{},()=>{}),t}};",
    "var $O=class extends Base.Tf{constructor(e,t,n,r,i,a){super(),this.appServerConnection=e,this.getController=t,this.isEligible=n,this.loadApplications=r,this.loadApplicationsByBundleIdentifier=i,this.history=a}async getState(){let e=this.#i(),[t,n]=await Promise.all([this.appServerConnection.isChronicleFeatureConfigured(),e.status()]);return this.#t(t,n.state)}async retryActivation(){this.#r();try{await this.appServerConnection.reconcileSkysightChronicle()}catch{}return this.getState()}async setEnabled(e){if(!e)return this.#e();try{let e=await this.appServerConnection.enableSkysightChronicle();return await this.#n(!0),this.#t(!0,e.state)}catch(e){if(e===`pending`)return{enabled:!0,recorderState:`stopped`,activationState:`waiting_for_permissions`};throw e}}async pause(){return this.#i().pause()}async resume(){return this.appServerConnection.resumeChronicle()}async getSettings(){return this.#i().getSettings()}async updateSettings(e){return this.#i().updateSettings(e)}async listApplications(){return this.#r(),this.loadApplications()}async resolveApplications(e){return this.#r(),this.loadApplicationsByBundleIdentifier(e)}async listHistory(){return this.#r(),this.history.list()}async listHistorySuggestions(){return this.#r(),this.history.listSuggestions()}async listHistorySummaryIntervals({sinceMs:e}){return this.#r(),this.history.listSummaryIntervals(e)}async clearHistory(e,t){await this.#i().clearHistory(e,t)}async#e(){return this.#i().stopRecorder()}#t(e,t){return{enabled:e,recorderState:t}}async#n(e){await this.appServerConnection.sendAppServerRequest(`config/value/write`,{keyPath:`chronicle`,value:e})}#r(){if(!this.isEligible())throw Error(`Chronicle is not available`)}#i(){this.#r();let e=this.getController();if(e==null)throw Error(`Chronicle is unavailable`);return e}};",
    "function Cr(){return{skysight:false}}let N=process.platform===`darwin`,xe;var Ce={requestComputerUseWorker(){}},Xe={reconcileComputerHistoryPluginInstallation(){}},U={broadcastQueryCacheInvalidation(){}},V={codexHome:`/tmp`};async function archive(e){return e}",
    "N&&(xe=new Hse({request:Ce.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:e=>{Xe.reconcileComputerHistoryPluginInstallation(e)},archiveLegacyChronicleSkill:async()=>{await archive({codexHome:V.codexHome,reason:`skysight_gate_enabled`})&&U.broadcastQueryCacheInvalidation([`skills`])}}));",
    "var appOptions={getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null};",
    "var Host=class{constructor(){this.options=appOptions;let i={};this.services={chronicle:process.platform===`darwin`&&this.options.getSkysightRecorderController!=null?new $O(i,this.options.getSkysightRecorderController,()=>Cr().skysight,()=>[],()=>[],{}):void 0}}};",
    "var bridge={\"get-global-state\":async({key:e})=>null};",
  ].join("");
}

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

test("record-and-replay dictation descriptor tracks moved upstream composer bundle", () => {
  const descriptor = descriptors.find((patch) => patch.id === "record-replay-dictation-transcript");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("app-initial-C-fROkKo.js"), true);
  assert.equal(descriptor.assetMatch(currentComposerTranscriptFixture()), true);
  assert.equal(descriptor.pattern.test("app-initial~app-main~onboarding-page-BUwCKIcU.js"), false);
  assert.equal(descriptor.pattern.test("use-dictation-BUwCKIcU.js"), false);
  assert.equal(descriptor.pattern.test("use-dictation-hotkey-BUwCKIcU.js"), false);
});

test("record-and-replay global dictation descriptor tracks floating dictation bundles", () => {
  const descriptor = descriptors.find((patch) => patch.id === "record-replay-global-dictation-transcript");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("global-dictation-orb-BTMuOubw.js"), true);
  assert.equal(descriptor.pattern.test("global-dictation-page-C-bhTjfc.js"), true);
  assert.equal(descriptor.pattern.test("use-dictation-BUwCKIcU.js"), false);
});

test("record-and-replay bridge patch is idempotent and uses execFile", () => {
  assert.equal(descriptors.length, 5);
  const source = currentChronicleControllerFixture();

  const chroniclePatched = applyChronicleSkysightMainBridgePatch(source);
  const patched = applyRecordReplayMainBridgePatch(chroniclePatched);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayMainBridgePatch(patched), patched);
  assert.match(patched, /"linux-record-replay-doctor":async/);
  assert.match(patched, /"chronicle-permissions":async/);
  assert.match(patched, /chronicleSidecarPresent/);
  assert.match(patched, /chronicleSidecarProcessState/);
  assert.match(patched, /chronicleOcrAvailable/);
  assert.match(patched, /chronicleOcrStatus/);
  assert.match(patched, /chronicleOcrBackend/);
  assert.match(patched, /codexLinuxChronicleRequest/);
  assert.match(patched, /request:process\.platform===`linux`\?codexLinuxChronicleRequest:/);
  assert.match(patched, /chronicle:process\.platform===`darwin`/);
  assert.doesNotMatch(patched, /chronicle:\(process\.platform===`darwin`\|\|process\.platform===`linux`\)/);
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
  const variants = {
    "missing current bridge handler": patched.replace(
      '"linux-record-replay-status":async',
      '"linux-record-replay-status-missing":async',
    ),
    "misplaced bridge payload": `${patched.replace(
      `${bridgePayload},"get-global-state":async`,
      '"get-global-state":async',
    )}var misplaced={${bridgePayload}};`,
    "duplicate bridge payload": patched.replace(
      `${bridgePayload},"get-global-state":async`,
      `${bridgePayload},${bridgePayload},"get-global-state":async`,
    ),
    "helper-only partial": `${helperPayload}\n${chroniclePatched}`,
    "duplicate helper payload": `${helperPayload}\n${patched}`,
  };

  for (const [name, drifted] of Object.entries(variants)) {
    assert.notEqual(drifted, patched, name);
    const { value, warnings } = captureWarns(() => applyRecordReplayMainBridgePatch(drifted));
    assert.equal(value, drifted, name);
    assert.equal(warnings.length, 1, name);
    assert.match(warnings[0], /incomplete Record & Replay main bridge patch/, name);
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
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:true,json:{state:"running",is_running:true,paused:false}})`,
    context,
  );
  assert.equal(state.enabled, true);
  assert.equal(state.running, true);
  assert.equal(state.state, "running");

  const ocrState = vm.runInNewContext(
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:true,json:{state:"running",is_running:true,ocr_available:true,ocr_status:"completed",ocr_backend:"tesseract-cli",ocr_language:"eng"}})`,
    context,
  );
  assert.equal(ocrState.chronicleOcrAvailable, true);
  assert.equal(ocrState.chronicleOcrStatus, "completed");
  assert.equal(ocrState.chronicleOcrBackend, "tesseract-cli");
  assert.equal(ocrState.chronicleOcrLanguage, "eng");

  const paused = vm.runInNewContext(
    `${helperSource};codexLinuxChronicleControlStateFromSkysight({ok:true,json:{state:"paused",is_running:true,paused:true}})`,
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
        callback(null, JSON.stringify({ state: "stopped", is_running: false, paused: false }), "");
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
    { state: "stopped", is_running: false, paused: false },
    { state: "running", is_running: true, paused: false },
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
    { state: "stopped", is_running: false, paused: false },
    { state: "running", is_running: true, paused: false, summary_agent_enabled: true },
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
  assert.match(patched, /\(N\|\|process\.platform===`linux`\)&&\(xe=new Hse/);
  assert.match(patched, /getSkysightRecorderController:\(\)=>process\.platform===`linux`\|\|Cr\(\)\.skysight\?xe:null/);
  assert.match(patched, /chronicle:process\.platform===`darwin`/);
  assert.doesNotMatch(patched, /chronicle:\(process\.platform===`darwin`\|\|process\.platform===`linux`\)/);
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

test("record-and-replay HUD patch is idempotent and appends runtime UI", () => {
  const source = "console.log('webview');\n//# sourceMappingURL=index.js.map";
  const patched = applyRecordReplayHudPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayHudPatch(patched), patched);
  assert.match(patched, /sourceMappingURL=index\.js\.map\n;\(\(\)=>/);
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
    "function send(e,n){let i=`Create an image of a neon cabin`;i.length>0&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))}",
    "async function send(){let l=c.trim();l.length>0?(o==null?_m.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:l}):o.setTranscript(l),r.performance.mark(`transcript_dispatched`),t.action===`send`?await a.onTranscriptSend(l):(await a.onTranscriptInsert(l),U.current===t&&U.current.action===`send`&&await a.onTranscriptSend(``))):a.onTranscriptCancel?.()}",
  ];
  for (const source of sources) {
    assert.equal(applyRecordReplayDictationTranscriptPatch(source), source);
  }
});

test("record-and-replay matches and executes the current composer transcript block", async () => {
  const source = currentComposerTranscriptFixture();
  const patched = applyRecordReplayDictationTranscriptPatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayDictationTranscriptPatch(patched), patched);
  assert.match(patched, /codexLinuxRecordReplayCaptureTranscript\?\.\(p,i\.action\)/);
  assert.match(patched, /let e=c==null\?void 0:a\.dictationSessionId/);
  assert.match(patched, /onTranscriptSend\(p,e\)/);
  assert.match(patched, /onTranscriptInsert\(p,e\)/);

  const context = {
    Date,
    globalThis: {
      events: [],
      codexLinuxRecordReplayCaptureTranscript: (transcript, action) => {
        context.globalThis.events.push(["capture", transcript, action]);
        return true;
      },
    },
    une: { getInstance: () => ({ dispatchMessage() {} }) },
  };
  vm.runInNewContext(`${patched};globalThis.run=send`, context);
  await context.globalThis.run();
  assert.deepEqual(JSON.parse(JSON.stringify(context.globalThis.events)), [
    ["capture", "Create an image of a neon cabin", "send"],
    ["send", "Create an image of a neon cabin", "session-1"],
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
    ambiguous: current.replace("else if(i.action===`send`){", "else if(i.action===`send`){if(false){}else if(i.action===`send`){}"),
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
    "async function L(e,t,n=null){let r=await f({transcript:n==null?await y(e.audio):await R(n,e.audio),cleanupEnabled:t});U===e&&(U=null),a.dispatchMessage(`global-dictation-completed`,{sessionId:e.sessionId,text:r})}";
  const patched = applyRecordReplayGlobalDictationTranscriptPatch(source);

  assert.equal(patched, source);
});

test("record-and-replay matches the official 26.831.20005 global dictation success chain", () => {
  const source =
    "async function U(e,t,n=null){let r=Date.now(),i=n==null?await I(e.audio):await W(n,e.audio);e.analytics.performance.mark(`final_received`);let a=await E({transcript:i,cleanupEnabled:t});J===e&&(J=null),a.trim().length>0&&e.recordingPersistence?.setTranscript(a.trim()),B.dispatchMessage(`global-dictation-completed`,{sessionId:e.sessionId,text:a}),e.analytics.performance.mark(`transcript_dispatched`)}";
  const patched = applyRecordReplayGlobalDictationTranscriptPatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayGlobalDictationTranscriptPatch(patched), patched);
  assert.match(patched, /codex-linux-record-replay-global-dictation/);
  assert.match(patched, /B\.dispatchMessage\(`global-dictation-completed`,\{sessionId:e\.sessionId,text:a\}\)/);
});

test("record-and-replay current transcript drift remains byte-identical", () => {
  const composer =
    "let l=c.trim();l.length>0&&(a==null?_m.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:l}):a.persistTranscript(l),t.performance.mark(`transcript_dispatched`),e.action===`send`?i.onTranscriptSend(l):i.onTranscriptInsert(l))";
  const global =
    "e.analytics.performance.mark(`transcript_saved`),B.dispatchMessage(`global-dictation-completed`,{sessionId:e.sessionId,text:a})";

  assert.equal(applyRecordReplayDictationTranscriptPatch(composer), composer);
  assert.equal(applyRecordReplayGlobalDictationTranscriptPatch(global), global);
});

test("record-and-replay generated transcript runtimes are syntactically valid", () => {
  const source = currentComposerTranscriptFixture();
  const globalDictationSource =
    "async function U(e,t,n=null){let r=Date.now(),i=n==null?await I(e.audio):await W(n,e.audio);e.analytics.performance.mark(`final_received`);let a=await E({transcript:i,cleanupEnabled:t});J===e&&(J=null),a.trim().length>0&&e.recordingPersistence?.setTranscript(a.trim()),B.dispatchMessage(`global-dictation-completed`,{sessionId:e.sessionId,text:a}),e.analytics.performance.mark(`transcript_dispatched`)}";

  assert.doesNotThrow(() => new vm.Script(recordReplayHudRuntimeSource()));
  assert.doesNotThrow(() => new vm.Script(applyRecordReplayDictationTranscriptPatch(source)));
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

test("record-and-replay plugin gate is idempotent and linux-only", () => {
  const source = [
    "var Kr=[{...n.Ds.codexAppTools,isAvailable:()=>!0},{...n.Ds.browser,autoInstallOptOutKey:n.As(n.Ds.browser.name),isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{...n.Ds.computerUse,autoInstallOptOutKey:n.As(n.Ds.computerUse.name),isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse},{...n.Ds.computerUse,autoInstallOptOutKey:n.As(n.Ds.computerUse.name),isAvailable:({features:e,platform:t})=>t===`win32`&&e.computerUse},{...n.Ds.latex,isAvailable:()=>!0},{...n.Ds.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyRecordReplayPluginGatePatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyRecordReplayPluginGatePatch(patched), patched);
  assert.match(patched, /installWhenMissing:!0,name:`record-and-replay`,isAvailable:\(\{platform:e\}\)=>e===`linux`/);
  assert.match(patched, /\.\.\.n\.Ds\.computerUse,autoInstallOptOutKey:n\.As\(n\.Ds\.computerUse\.name\)/);
});

test("record-and-replay plugin gate rejects obsolete isEnabled availability contract", () => {
  const source = [
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{installWhenMissing:!0,name:`record-and-replay`,isEnabled:({platform:e})=>e===`linux`},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  assert.throws(
    () => applyRecordReplayPluginGatePatch(source),
    /obsolete isEnabled availability contract/,
  );
});

test("record-and-replay plugin gate rejects mixed current and obsolete availability contracts", () => {
  const source = [
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{installWhenMissing:!0,name:`record-and-replay`,isAvailable:({platform:e})=>e===`linux`},{installWhenMissing:!0,name:`record-and-replay`,isEnabled:({platform:e})=>e===`linux`},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  assert.throws(
    () => applyRecordReplayPluginGatePatch(source),
    /obsolete isEnabled availability contract/,
  );
});

test("record-and-replay plugin gate rejects a misplaced current availability contract", () => {
  const source = [
    "var misplaced={installWhenMissing:!0,name:`record-and-replay`,isAvailable:({platform:e})=>e===`linux`};",
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  assert.throws(
    () => applyRecordReplayPluginGatePatch(source),
    /invalid isAvailable availability contract/,
  );
});

test("record-and-replay plugin gate rejects a non-Linux current availability predicate", () => {
  const source = [
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{installWhenMissing:!0,name:`record-and-replay`,isAvailable:()=>!0},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  assert.throws(
    () => applyRecordReplayPluginGatePatch(source),
    /invalid isAvailable availability contract/,
  );
});

test("record-and-replay plugin gate rejects incomplete descriptor metadata", () => {
  const source = [
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{name:`record-and-replay`,isAvailable:({platform:e})=>e===`linux`},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  assert.throws(
    () => applyRecordReplayPluginGatePatch(source),
    /invalid isAvailable availability contract/,
  );
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
