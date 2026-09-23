#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
  applyChronicleSkysightMainBridgePatch,
  chronicleControllerContract,
  descriptors,
  recordReplayRuntimeHelperSource,
} = require("./patch.js");

const featureDir = __dirname;

function repoRoot() {
  return path.resolve(featureDir, "../..");
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

function retiredChronicleMainFixture() {
  return [
    "var Base={Tf:class{}};",
    "var Empty={state:`stopped`,currentSegmentEventsPath:null,currentSegmentMetadataPath:null};",
    "var Hse=class{dependencies;cachedStatus=Empty;desiredState=`stopped`;pendingOperation=Promise.resolve();pendingStatus=null;constructor(e){this.dependencies=e}getCachedStatus(){return this.cachedStatus}status(){return this.pendingStatus??=this.request(`skysightStatus`).finally(()=>{this.pendingStatus=null}),this.pendingStatus}enable(){return this.desiredState=`running`,this.runSerialized(async()=>(await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0),this.request(`skysightStart`)))}reconcileEnabled(){return this.desiredState=`running`,this.runSerialized(async()=>{await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0);let e=await this.status();return e.state===`stopped`?this.request(`skysightStart`):(this.desiredState===`running`&&(this.desiredState=e.state),e)})}disable(){return this.desiredState=`stopped`,this.runSerialized(async()=>{let e=this.cachedStatus.state===`stopped`?this.cachedStatus:await this.stopRecorder();return this.dependencies.reconcileComputerHistoryPluginInstallation(!1),e})}stop(){return this.desiredState=`stopped`,this.runSerialized(()=>this.stopRecorder())}pause(e){let t=this.desiredState,n=e==null?`paused`:`running`;return this.desiredState=n,this.runSerialized(()=>this.requestPauseResume(`skysightPause`,e)).catch(e=>{throw this.desiredState===n&&(this.desiredState=t),e})}resume(){return this.desiredState=`running`,this.runSerialized(async()=>{let e=await this.status();return e.state===`stopped`?this.request(`skysightStart`):e.state===`running`?e:this.requestPauseResume(`skysightResume`)})}getSettings(){return this.dependencies.request({method:`skysightGetSettings`,params:{}})}updateSettings(e){return this.dependencies.request({method:`skysightUpdateSettings`,params:{settings:e}})}clearHistory(e,t){return this.dependencies.request({method:`skysightClearHistory`,params:{interval:t,scope:e}}).then(e=>(this.cachedStatus=e,e))}requestPauseResume(e,t){return this.dependencies.request({method:e,params:t==null?{}:{duration:t}}).then(e=>(this.cachedStatus=e,e))}request(e){return this.dependencies.request({method:e,params:{}}).then(e=>(this.cachedStatus=e,e))}async stopRecorder(){let e=await this.request(`skysightStop`);if(e.state!==`stopped`||e.currentSegmentEventsPath!=null||e.currentSegmentMetadataPath!=null)throw Error(`invalid stop`);return e}runSerialized(e){let t=this.pendingOperation.then(e,e);return this.pendingOperation=t.then(()=>{},()=>{}),t}};",
    "var $O=class extends Base.Tf{constructor(e,t,n,r,i,a){super(),this.appServerConnection=e,this.getController=t,this.isEligible=n,this.loadApplications=r,this.loadApplicationsByBundleIdentifier=i,this.history=a}async getState(){this.isEligible();return this.getController().status()}async setEnabled(e){return e?this.appServerConnection.enableSkysightChronicle():this.getController().disable()}async pause(){return this.getController().pause()}async resume(){return this.appServerConnection.resumeChronicleSidecar()}async getSettings(){return this.getController().getSettings()}async updateSettings(e){return this.getController().updateSettings(e)}async listApplications(){return this.isEligible(),this.loadApplications()}async resolveApplications(e){return this.isEligible(),this.loadApplicationsByBundleIdentifier(e)}async listHistory(){return this.isEligible(),this.history.list()}async listHistorySuggestions(){return this.isEligible(),this.history.listSuggestions()}async listHistorySummaryIntervals({sinceMs:e}){return this.isEligible(),this.history.listSummaryIntervals(e)}async clearHistory(e,t){await this.getController().clearHistory(e,t)}};",
    "function Cr(){return{skysight:false}}let N=process.platform===`darwin`,xe;",
    "var Ce={requestComputerUseWorker(e){return globalThis.worker(e)}},Xe={reconcileComputerHistoryPluginInstallation(e){return globalThis.reconcileComputerHistoryPluginInstallation(e)}},U={broadcastQueryCacheInvalidation(){}},V={codexHome:`/tmp`};async function archive(e){return globalThis.archiveLegacyChronicleSkill(e)}",
    "N&&(xe=new Hse({request:Ce.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:e=>{Xe.reconcileComputerHistoryPluginInstallation(e)},archiveLegacyChronicleSkill:async()=>{await archive({codexHome:V.codexHome,reason:`skysight_gate_enabled`})&&U.broadcastQueryCacheInvalidation([`skills`])}}));",
    "var appOptions={getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null};",
    "var connection={enableSkysightChronicle:()=>xe.enable(),resumeChronicleSidecar:()=>xe.resume()};",
    "var Host=class{constructor(){this.options=appOptions;let i=connection;this.services={chronicle:process.platform===`darwin`&&this.options.getSkysightRecorderController!=null?new $O(i,this.options.getSkysightRecorderController,()=>Cr().skysight,()=>globalThis.applications,e=>globalThis.resolvedApplications,{list:()=>globalThis.history,listSuggestions:()=>globalThis.historySuggestions,listSummaryIntervals:e=>[e]}):void 0}}};var host=new Host;",
    "var bridge={\"get-global-state\":async({key:e})=>null};",
  ].join("");
}

function currentChronicleMainFixture() {
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
    "var bridge={\"get-global-state\":async({key:e})=>null};",
  ].join("");
}

test("chronicle-skysight is an independent disabled-by-default feature", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(featureDir, "feature.json"), "utf8"),
  );

  assert.equal(manifest.id, "chronicle-skysight");
  assert.equal(manifest.title, "Chronicle / Skysight Activity Memory");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires ?? [], []);
  assert.equal(fs.existsSync(path.join(featureDir, "README.md")), true);
});

test("chronicle-skysight owns standalone plugin and backend stage files", () => {
  for (const relative of [
    "stage.sh",
    "cleanup.sh",
    "plugin-template/.codex-plugin/plugin.json",
    "plugin-template/.mcp.json",
    "plugin-template/skills/chronicle-skysight/SKILL.md",
  ]) {
    assert.equal(fs.existsSync(path.join(featureDir, relative)), true, relative);
  }
});

test("chronicle-skysight stages restricted MCP plugin and shared backend", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chronicle-skysight-stage-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const marketplace = path.join(
      installDir,
      "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
    );
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_RECORD_REPLAY_LINUX_SOURCE: fakeBinary,
      },
      stdio: "pipe",
    });

    const nativeBinary = path.join(installDir, "resources/native/codex-record-replay-linux");
    const pluginDir = path.join(
      installDir,
      "resources/plugins/openai-bundled/plugins/chronicle-skysight",
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    const plugins = JSON.parse(fs.readFileSync(marketplace, "utf8")).plugins;
    assert.equal(fs.statSync(nativeBinary).mode & 0o111 ? true : false, true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-record-replay-linux")), true);
    assert.deepEqual(mcp.mcpServers["chronicle-skysight"], {
      command: "./bin/codex-record-replay-linux",
      args: ["skysight", "mcp"],
      cwd: ".",
    });
    assert.equal(
      plugins.some(
        (plugin) => plugin.name === "chronicle-skysight"
          && plugin.source?.path === "./plugins/chronicle-skysight",
      ),
      true,
    );
    assert.equal(plugins.some((plugin) => plugin.name === "record-and-replay"), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("chronicle-skysight reuses the updater-staged backend without Cargo", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chronicle-skysight-backend-"));
  try {
    const backend = path.join(workspace, "target/release/codex-record-replay-linux");
    fs.mkdirSync(path.dirname(backend), { recursive: true });
    fs.writeFileSync(backend, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const selected = execFileSync(
      "bash",
      ["-c", ". \"$FEATURE_DIR/shared-backend.sh\"; build_chronicle_skysight_backend"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          FEATURE_DIR: featureDir,
          SCRIPT_DIR: workspace,
          CODEX_RECORD_REPLAY_LINUX_SOURCE: "",
          HOME: path.join(workspace, "home-without-cargo"),
        },
      },
    ).trim();

    assert.equal(selected, backend);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("chronicle-skysight owns the activity-memory bridge", () => {
  const source = currentChronicleMainFixture();

  const patched = applyChronicleSkysightMainBridgePatch(source);

  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "linux-chronicle-skysight-main-bridge");
  assert.equal(chronicleControllerContract(source), "current");
  assert.notEqual(patched, source);
  assert.equal(chronicleControllerContract(patched), "patched");
  assert.equal(applyChronicleSkysightMainBridgePatch(patched), patched);
  assert.match(patched, /"chronicle-permissions":async/);
  assert.match(patched, /"linux-record-replay-skysight-start":async/);
  assert.match(patched, /request:process\.platform===`linux`\?codexLinuxChronicleRequest:/);
  assert.match(patched, /reconcileComputerHistoryPluginInstallation:process\.platform===`linux`\?\(\)=>\{\}:/);
  assert.match(patched, /archiveLegacyChronicleSkill:process\.platform===`linux`\?async\(\)=>\{\}:/);
  assert.match(patched, /chronicle:process\.platform===`darwin`/);
  assert.doesNotMatch(patched, /chronicle:\(process\.platform===`darwin`\|\|process\.platform===`linux`\)/);
  assert.match(patched, /getSkysightRecorderController:\(\)=>process\.platform===`linux`\|\|Cr\(\)\.skysight\?xe:null/);
  assert.doesNotMatch(patched, /"linux-record-replay-start":async/);
  assert.doesNotMatch(patched, /"linux-record-replay-draft-skill":async/);
});

test("chronicle-skysight fails closed for missing duplicate ambiguous mixed and partial contracts", () => {
  const current = currentChronicleMainFixture();
  const patched = applyChronicleSkysightMainBridgePatch(current);
  const serviceStart = current.indexOf("var $O=class");
  const serviceEnd = current.indexOf(";function Cr", serviceStart) + 1;
  const duplicateService = current
    .slice(serviceStart, serviceEnd)
    .replace("var $O=class", "var $P=class");
  const variants = {
    retiredRelease: retiredChronicleMainFixture(),
    missing: current.replace("this.request(`skysightStatus`)", "this.request(`statusChanged`)"),
    missingReconciliationDependency: current.replace(
      "reconcileComputerHistoryPluginInstallation:e=>",
      "reconcileHistoryPluginInstallation:e=>",
    ),
    missingArchiveDependency: current.replace(
      "archiveLegacyChronicleSkill:async()=>",
      "archiveChronicleSkill:async()=>",
    ),
    ambiguousArchiveDependency: current
      + "var duplicateArchive={archiveLegacyChronicleSkill:async()=>{await archive({reason:`skysight_gate_enabled`})}};",
    duplicate: current + current,
    ambiguous: current.slice(0, serviceEnd) + duplicateService + current.slice(serviceEnd),
    mixed: current + patched,
    partial: patched.replace(
      "getSkysightRecorderController:()=>process.platform===`linux`||Cr().skysight?xe:null",
      "getSkysightRecorderController:()=>Cr().skysight?xe:null",
    ),
    missingSettings: current.replace("async getSettings()", "async readSettings()"),
    missingApplicationResolution: current.replace("async resolveApplications(e)", "async resolvePrograms(e)"),
    missingHistory: current.replace("async listHistory()", "async readHistory()"),
    missingHistorySuggestions: current.replace("async listHistorySuggestions()", "async readHistorySuggestions()"),
    missingHistoryIntervals: current.replace("async listHistorySummaryIntervals({sinceMs:e})", "async readHistorySummaryIntervals({sinceMs:e})"),
    missingClear: current.replace("async clearHistory(e,t)", "async eraseHistory(e,t)"),
  };

  for (const [name, source] of Object.entries(variants)) {
    assert.equal(chronicleControllerContract(source), "drifted", name);
    const result = captureWarns(() => applyChronicleSkysightMainBridgePatch(source));
    assert.equal(result.value, source, name);
    assert.equal(result.warnings.length, 1, name);
    assert.match(result.warnings[0], /coherent current Chronicle controller contract/, name);
  }
});

test("chronicle-skysight drives recorder controls without exposing the unsupported Linux service", async () => {
  const source = currentChronicleMainFixture();
  const patched = applyChronicleSkysightMainBridgePatch(source);
  const calls = [];
  const responses = [
    { state: "stopped", is_running: false, currentSegmentEventsPath: "/last/events.jsonl", currentSegmentMetadataPath: "/last/metadata.json" },
    { state: "running", is_running: true },
    { state: "paused", is_running: true, paused: true },
    { state: "paused", is_running: true, paused: true },
    { state: "running", is_running: true },
    { state: "stopped", is_running: false, currentSegmentEventsPath: "/last/events.jsonl", currentSegmentMetadataPath: "/last/metadata.json" },
    { ok: true, exclusions: [{ kind: "app", value: "secret-app" }] },
    { ok: true, exclusions: [] },
  ];
  const childProcess = {
    execFile(_bin, args, _options, callback) {
      calls.push(args);
      callback(null, JSON.stringify(responses.shift()), "");
    },
  };
  const context = {
    console,
    globalThis: { worker() { throw new Error("mac worker unavailable"); } },
    JSON,
    Promise,
    String,
    process: {
      platform: "linux",
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
    },
    require(id) {
      if (id === "node:child_process") return childProcess;
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };

  require("node:vm").runInNewContext(
    `${patched};globalThis.chronicle=host.services.chronicle;globalThis.controller=xe;globalThis.bridge=bridge;`,
    context,
  );
  assert.equal(context.globalThis.chronicle, undefined);
  for (const method of [
    "getSettings",
    "updateSettings",
    "listApplications",
    "resolveApplications",
    "listHistory",
    "listHistorySuggestions",
    "listHistorySummaryIntervals",
    "clearHistory",
  ]) {
    assert.equal(context.globalThis.chronicle?.[method], undefined, method);
  }
  assert.ok(context.globalThis.controller);
  assert.equal((await context.globalThis.controller.status()).state, "stopped");
  assert.equal((await context.globalThis.controller.enable()).state, "running");
  assert.equal((await context.globalThis.controller.pause()).state, "paused");
  assert.equal((await context.globalThis.controller.resume()).state, "running");
  assert.equal((await context.globalThis.controller.stop()).state, "stopped");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["skysight", "status"],
    ["skysight", "start", "--source", "chronicle-desktop", "--owner", "manual-continuous", "--summary-agent", "enabled"],
    ["skysight", "pause", "--reason", "chronicle-desktop"],
    ["skysight", "status"],
    ["skysight", "resume"],
    ["skysight", "stop"],
  ]);
  for (const invoke of [
    () => context.globalThis.controller.getSettings(),
    () => context.globalThis.controller.updateSettings({ excludedApplications: [] }),
    () => context.globalThis.controller.clearHistory("all", "all"),
  ]) {
    await assert.rejects(invoke(), /Unsupported Linux Chronicle method/);
  }
  const exclusions = await context.globalThis.bridge["linux-record-replay-skysight-list-exclusions"]();
  assert.deepEqual(JSON.parse(JSON.stringify(exclusions.json.exclusions)), [
    { kind: "app", value: "secret-app" },
  ]);
  const updated = await context.globalThis.bridge["linux-record-replay-skysight-update-exclusion"]({
    kind: "app",
    value: "secret-app",
    reason: "private",
    remove: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(updated.json.exclusions)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(-2))), [
    ["skysight", "list-exclusions"],
    ["skysight", "update-exclusion", "--kind", "app", "--value", "secret-app", "--reason", "private", "--remove"],
  ]);
});

test("chronicle-skysight Linux controller never invokes upstream migration dependencies", async () => {
  const patched = applyChronicleSkysightMainBridgePatch(currentChronicleMainFixture());
  const calls = [];
  const context = {
    console,
    globalThis: {
      archiveLegacyChronicleSkill() {
        throw new Error("Linux archived the legacy Chronicle skill");
      },
      reconcileComputerHistoryPluginInstallation() {
        throw new Error("Linux reconciled the upstream computer-history plugin");
      },
      worker() {
        throw new Error("mac worker unavailable");
      },
    },
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
            const state = args[1] === "stop"
              ? { state: "stopped", is_running: false }
              : { state: "running", is_running: true };
            callback(null, JSON.stringify(state), "");
          },
        };
      }
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };

  require("node:vm").runInNewContext(
    `${patched};globalThis.controller=xe;`,
    context,
  );
  assert.equal((await context.globalThis.controller.enable()).state, "running");
  assert.equal((await context.globalThis.controller.reconcileEnabled()).state, "running");
  assert.equal((await context.globalThis.controller.disable()).state, "stopped");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["skysight", "start", "--source", "chronicle-desktop", "--owner", "manual-continuous", "--summary-agent", "enabled"],
    ["skysight", "status"],
    ["skysight", "stop"],
  ]);
});

test("chronicle-skysight rejects timed Linux pause before spawning and rolls back desired state", async () => {
  const patched = applyChronicleSkysightMainBridgePatch(currentChronicleMainFixture());
  const calls = [];
  const context = {
    console,
    globalThis: {
      archiveLegacyChronicleSkill() {
        throw new Error("Linux archived the legacy Chronicle skill");
      },
      reconcileComputerHistoryPluginInstallation() {
        throw new Error("Linux reconciled the upstream computer-history plugin");
      },
      worker() {
        throw new Error("mac worker unavailable");
      },
    },
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
            callback(null, JSON.stringify({ state: "running", is_running: true }), "");
          },
        };
      }
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };

  require("node:vm").runInNewContext(
    `${patched};globalThis.controller=xe;`,
    context,
  );
  await context.globalThis.controller.enable();
  const callsBeforePause = calls.length;
  await assert.rejects(
    context.globalThis.controller.pause(60_000),
    /Timed Linux Chronicle pause is unsupported/,
  );
  assert.equal(context.globalThis.controller.desiredState, "running");
  assert.equal(calls.length, callsBeforePause);
});

test("chronicle-skysight preserves upstream migration dependencies outside Linux", async () => {
  const patched = applyChronicleSkysightMainBridgePatch(currentChronicleMainFixture());
  const archived = [];
  const reconciled = [];
  const context = {
    console,
    globalThis: {
      archiveLegacyChronicleSkill(options) {
        archived.push(options);
        return {};
      },
      reconcileComputerHistoryPluginInstallation(enabled) {
        reconciled.push(enabled);
      },
      async worker({ method }) {
        return method === "skysightStop"
          ? { state: "stopped", currentSegmentEventsPath: null, currentSegmentMetadataPath: null }
          : { state: "running" };
      },
    },
    JSON,
    Promise,
    String,
    process: { platform: "darwin", env: {}, cwd: () => "/tmp" },
  };

  require("node:vm").runInNewContext(
    `${patched};globalThis.controller=xe;`,
    context,
  );
  await context.globalThis.controller.enable();
  await context.globalThis.controller.reconcileEnabled();
  await context.globalThis.controller.disable();
  assert.equal(archived.length, 2);
  assert.deepEqual(reconciled, [true, true, false]);
});

test("chronicle-skysight rejects unsupported and failed Linux controller requests", async () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const context = {
    childProcess: {
      execFile(_bin, _args, _options, callback) {
        callback(new Error("backend failed"), "", "failed");
      },
    },
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
    },
    JSON,
    Promise,
    String,
  };
  await assert.rejects(
    require("node:vm").runInNewContext(
      `${helperSource};codexLinuxChronicleRequest({method:"skysightStatus",params:{}})`,
      context,
    ),
    /backend failed/,
  );
  await assert.rejects(
    require("node:vm").runInNewContext(
      `${helperSource};codexLinuxChronicleRequest({method:"unknown",params:{}})`,
      context,
    ),
    /Unsupported Linux Chronicle method/,
  );
});
