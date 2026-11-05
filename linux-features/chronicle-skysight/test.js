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
  inspectChronicleBridge,
  descriptors,
  recordReplayRuntimeHelperSource,
} = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
require("./main-bridge-native.test.js");

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

const { graphBody, fixture: requestGraphFixture } = require("../../scripts/patches/lib/fixtures/main-request-graph.js");
const CHRONICLE_NATIVE_BUSINESS = "var Base={TF:class{}};let Empty={state:\"stopped\",eventStreamRootPath:null,currentSegmentEventsPath:null,currentSegmentMetadataPath:null,suppressedEventsPath:null,startedAtMs:null,endedAtMs:null};class Hse{dependencies;cachedStatus=Empty;desiredState=\"stopped\";pendingOperation=Promise.resolve();finishPendingPauseResume=null;pendingStatus=null;constructor(e){this.dependencies=e}getCachedStatus(){return this.cachedStatus}shouldReconcileAfterServiceRespawn(){return\"running\"===this.desiredState}status(){return null==this.pendingStatus&&(this.pendingStatus=this.request(\"skysightStatus\").then(e=>(\"stopped\"===e.state&&this.finishPendingPauseResume?.(e),e)).finally(()=>{this.pendingStatus=null})),this.pendingStatus}enable(){return this.desiredState=\"running\",this.runSerialized(()=>this.withFailedEnableRollback(async()=>(await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0),this.request(\"skysightStart\")))).catch(e=>{throw\"running\"===this.desiredState&&(this.desiredState=\"stopped\"),e})}reconcileEnabled(){return this.desiredState=\"running\",this.runSerialized(()=>this.withFailedEnableRollback(async()=>{await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0);let e=await this.status();return\"stopped\"!==e.state?(\"running\"===this.desiredState&&(this.desiredState=e.state),e):this.request(\"skysightStart\")}))}disable(){let e=this.desiredState;return this.desiredState=\"stopped\",this.runSerialized(async()=>{let e=\"stopped\"===this.cachedStatus.state?this.cachedStatus:await this.stopRecorder();return this.dependencies.reconcileComputerHistoryPluginInstallation(!1),e}).catch(t=>{throw\"stopped\"===this.desiredState&&(this.desiredState=e),t})}stop(){return this.desiredState=\"stopped\",this.runSerialized(()=>this.stopRecorder())}pause(e){let t=this.desiredState,r=null==e?\"paused\":\"running\";return this.desiredState=r,this.runSerialized(()=>this.requestPauseResume(\"skysightPause\",e)).catch(e=>{throw this.desiredState===r&&(this.desiredState=t),e})}resume(){let e=this.desiredState;return this.desiredState=\"running\",this.runSerialized(async()=>{let e=await this.status();return\"stopped\"===e.state?this.request(\"skysightStart\"):\"running\"===e.state?e:this.requestPauseResume(\"skysightResume\")}).catch(t=>{throw\"running\"===this.desiredState&&(this.desiredState=e),t})}getSettings(){return this.dependencies.request({method:\"skysightGetSettings\",params:{}})}updateSettings(e){return this.dependencies.request({method:\"skysightUpdateSettings\",params:{settings:e}})}clearHistory(e,t){return this.dependencies.request({method:\"skysightClearHistory\",params:{interval:t,scope:e}}).then(e=>(this.cachedStatus=e,e))}requestPauseResume(e,t){return new Promise((r,n)=>{this.finishPendingPauseResume=r,(\"skysightPause\"===e?this.dependencies.request({method:e,params:null==t?{}:{duration:t}}):this.dependencies.request({method:e,params:{}})).then(r,n)}).then(e=>(this.cachedStatus=e,e)).finally(()=>{this.finishPendingPauseResume=null})}request(e){return this.dependencies.request({method:e,params:{}}).then(e=>(this.cachedStatus=e,e))}async withFailedEnableRollback(e){try{return await e()}catch(e){try{await this.stopRecorder()}catch(t){throw AggregateError([e,t],\"Failed to enable Chronicle and stop the recorder during rollback\")}throw e}}async stopRecorder(){let e=await this.request(\"skysightStop\");if(\"stopped\"!==e.state||null!=e.currentSegmentEventsPath||null!=e.currentSegmentMetadataPath)throw Error(\"Chronicle stopped but did not close its current segment\");return e}runSerialized(e){let t=this.pendingOperation.then(e,e);return this.pendingOperation=t.then(()=>{},()=>{}),t}}class $O extends Base.TF{appServerConnection;getController;isEligible;loadApplications;loadApplicationsByBundleIdentifier;history;constructor(e,t,r,n,i,s){super(),this.appServerConnection=e,this.getController=t,this.isEligible=r,this.loadApplications=n,this.loadApplicationsByBundleIdentifier=i,this.history=s}async getState(){let e=this.#tt(),[t,r]=await Promise.all([this.appServerConnection.isChronicleFeatureConfigured(),e.status()]);return this.#tr(t,r.state)}async retryActivation(){this.#tn();try{await this.appServerConnection.reconcileSkysightChronicle()}catch{}return this.getState()}async setEnabled(e){if(!e)return this.#ti();try{let e=await this.appServerConnection.enableSkysightChronicle();return await this.#ts(!0),this.#tr(!0,e.state)}catch(e){if(\"pending\"===e)return await this.#ts(!0),{enabled:!0,recorderState:\"stopped\",activationState:\"waiting_for_permissions\"};throw e}}async pause(){let e=await this.#tt().pause();return this.#tr(!0,e.state)}async resume(){this.#tn();let e=await this.appServerConnection.resumeChronicle();return this.#tr(e.enabled,e.running?\"running\":\"stopped\")}async getSettings(){return this.#tt().getSettings()}async updateSettings(e){return this.#tt().updateSettings(e)}async listApplications(){return this.#tn(),this.loadApplications()}async resolveApplications(e){return this.#tn(),this.loadApplicationsByBundleIdentifier(e)}async listHistory(){return this.#tn(),this.history.list()}async listHistorySuggestions(){return this.#tn(),this.history.listSuggestions()}async listHistorySummaryIntervals({sinceMs:e}){return this.#tn(),this.history.listSummaryIntervals(e)}async clearHistory(e,t){await this.#tt().clearHistory(e,t)}async #ti(){return this.#tt().disable()}#tr(e,t){return{enabled:e,recorderState:t}}async #ts(e){await this.appServerConnection.sendAppServerRequest(\"config/value/write\",{keyPath:\"chronicle\",value:e})}#tn(){if(!this.isEligible())throw Error(\"Chronicle is not available\")}#tt(){this.#tn();let e=this.getController();if(null==e)throw Error(\"Chronicle is unavailable\");return e}}function Cr(){return{skysight:globalThis.skysightEnabled===!0}}var Ce={requestComputerUseWorker(e){return globalThis.worker(e)}},Xe={reconcileComputerHistoryPluginInstallation(e){return globalThis.reconcileComputerHistoryPluginInstallation(e)}},U={broadcastQueryCacheInvalidation(){}},V={codexHome:\"/tmp\"};async function archive(e){return globalThis.archiveLegacyChronicleSkill(e)}class AppHost{constructor(services){this.services=services}}var connection={enableSkysightChronicle:()=>globalThis.controller.enable(),resumeChronicle:()=>globalThis.controller.resume()};";

function currentChronicleMainFixture() {
  let body=graphBody()
    .replace('this.seen=[]}async handleMessage', 'this.seen=[];this.services=this.createAppHost(connection).services}createAppHost(i){return new AppHost({chronicle:"darwin"===process.platform&&null!=this.options.getSkysightRecorderController?new $O(i,this.options.getSkysightRecorderController,()=>Cr().skysight,()=>globalThis.applications,e=>globalThis.resolvedApplications,{list:()=>globalThis.history,listSuggestions:()=>globalThis.historySuggestions,listSummaryIntervals:e=>[e]}):void 0})}async handleMessage')
    .replace('function runMainAppStartup(e){', 'function runMainAppStartup(e){let N="darwin"===process.platform,xe=null;')
    .replace('windowManager:window}){let host;', 'windowManager:window,getSkysightRecorderController:getController}){let host;')
    .replace('windowManager:window}));return host}', 'windowManager:window,getSkysightRecorderController:getController}));return host}')
    .replace('windowManager:e.windowManager});return created}', 'windowManager:e.windowManager,getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null});N&&(xe=new Hse({request:Ce.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:e=>{Xe.reconcileComputerHistoryPluginInstallation(e)},archiveLegacyChronicleSkill:async()=>{null!=await archive({codexHome:V.codexHome,reason:"skysight_gate_enabled"})&&U.broadcastQueryCacheInvalidation(["skills"])}}));globalThis.controller=xe;return created}');
  return requestGraphFixture(CHRONICLE_NATIVE_BUSINESS+body);
}

function evaluateChronicleFixture(source, context) {
  context.exports={};
  require("node:vm").runInNewContext(source+';globalThis.bridge=codexLinuxChronicleBridgeHandlers;',context);
  const module={exports:{}},load=()=>{throw Error("Unexpected fixture import")};
  load.d=(target,getters)=>{for(const [key,get]of Object.entries(getters))Object.defineProperty(target,key,{get})};
  context.exports.modules[82820](module,module.exports,load);
  const sender={sendInlineMessageForView(view,message){(context.globalThis.viewMessages??=[]).push({view,message})}};
  const state={get(){return null},set(){}};
  const host=module.exports.runMainAppStartup({globalState:state,chunkedMessageSender:sender,cancelled:[]});
  context.globalThis.host=host;context.globalThis.chronicle=host.services.chronicle;context.globalThis.fetchWrapper=host.fetchWrapper;
  return host;
}

function extractedFixture(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "chronicle-main-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".vite/build"), { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, ".vite/build", name), source);
  return root;
}
function productionBridge(root, enabled = ["chronicle-skysight"]) {
  const featuresConfigPath = path.join(root, "features.json");
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled, settings: {} }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(featureDir, ".."), featuresConfigPath });
  const selected = normalizePatchDescriptors(loaded.filter(descriptor => descriptor.id === "feature:chronicle-skysight:linux-chronicle-skysight-main-bridge"));
  const report = createPatchReport(); report.enabledFeatures = [...new Set(loaded.map(descriptor => descriptor.featureId))];
  applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
  return report.patches.find(patch => patch.name === "feature:chronicle-skysight:linux-chronicle-skysight-main-bridge");
}
function unchangedMainFiles(root, files) {
  for (const [name, expected] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, ".vite/build", name), "utf8"), expected, name);
}
function inertChronicleRuntime(source, onCommand = null) {
  const commands = [], messages = [];
  const context = { console, JSON, Promise, String,
    globalThis: { worker() { throw Error("Unexpected macOS worker"); }, viewMessages: messages },
    process: { platform: "linux", env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/inert/helper" }, cwd: () => "/inert" },
    require(id) {
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      if (id === "node:child_process") return { execFile(_binary, args, options, callback) {
        commands.push({ args: Array.from(args), options });
        const supplied = onCommand?.(Array.from(args));
        if (supplied) return callback(supplied.error ?? null, typeof supplied.stdout === "string" ? supplied.stdout : JSON.stringify(supplied.json), supplied.stderr ?? "");
        const state = args[1] === "start" || args[1] === "resume" ? "running" : args[1] === "pause" ? "paused" : "stopped";
        callback(null, JSON.stringify({ ok: true, schema_version: 1, state, is_running: state !== "stopped", paused: state === "paused" }), "");
      } };
      throw Error(`Unexpected import ${id}`);
    },
  };
  const host = evaluateChronicleFixture(source, context);
  return { commands, messages, context, host, async request(method, body = "{}") {
    const view = { id: "current-view" }, request = { type: "fetch", requestId: `${method}-${messages.length}`, url: `vscode://codex/${method}`, body };
    await host.handleMessage(view, request); return { view, request, response: messages.at(-1)?.message };
  } };
}

test("normal entry preserves opt-in reads, reports status failures and rejects non-object bodies before exec", async () => {
  const source = applyChronicleSkysightMainBridgePatch(currentChronicleMainFixture()), run = inertChronicleRuntime(source);
  assert.equal(run.commands.length, 0); assert.equal(run.context.globalThis.controller.desiredState, "stopped");
  for (const method of ["chronicle-permissions", "getChronicleSidecarControlState", "linux-record-replay-skysight-status"]) {
    const result = await run.request(method);
    assert.equal(result.response.requestId, result.request.requestId); assert.equal(result.response.responseType, "success");
    assert.equal(run.messages.at(-1).view, result.view);
  }
  assert.ok(run.commands.every(command => command.args.join(" ") === "skysight status"));
  assert.equal(run.context.globalThis.controller.desiredState, "stopped");
  for (const body of ["[]", "1", '"text"', "false", "null", "{"]) {
    const before = run.commands.length, result = await run.request("linux-record-replay-skysight-start", body);
    assert.equal(result.response.responseType, "error"); assert.equal(result.response.status, 500);
    assert.equal(run.commands.length, before, body);
  }
  for (const body of ["", undefined, "{}", { intervalSeconds: 3 }]) {
    const result = await run.request("linux-record-replay-skysight-start", body);
    assert.equal(result.response.responseType, "success"); assert.equal(run.commands.at(-1).args[1], "start");
  }
  for (const supplied of [
    { error: Error("backend failed"), json: { ok: false, error: "backend refused" }, stderr: "backend refused" },
    { json: { ok: false, error: "refused", state: "stopped", is_running: false } },
    { stdout: "not-json" }, { json: [] }, { json: { ok: true } },
  ]) {
    const failed = inertChronicleRuntime(source, () => supplied);
    for (const method of ["getChronicleSidecarControlState", "toggleChronicleSidecar"]) {
      const result = await failed.request(method), state = JSON.parse(result.response.bodyJsonString);
      assert.equal(state.enabled, false); assert.equal(state.running, false); assert.equal(state.state, "disabled");
      assert.ok(state.error); assert.equal(failed.commands.at(-1).args[1], "status");
    }
    assert.ok(failed.commands.every(command => command.args[1] === "status"), "invalid/failed status must never fall through to start");
    await assert.rejects(failed.context.globalThis.controller.status(), /backend failed|backend refused|refused|Invalid Linux Skysight status/);
  }
});

test("Chronicle canonical inspection binds real outer helpers/registry and provides an authoritative extension slot", async () => {
  const current = currentChronicleMainFixture(), patched = applyChronicleSkysightMainBridgePatch(current), base = inspectChronicleBridge(patched);
  assert.equal(base.state, "patched"); assert.equal(base.registry.extensions.length, 0);
  const registration = 'Object.assign(codexLinuxChronicleBridgeHandlers,{"foundation-extra":async()=>({ok:true,value:"registered"})});';
  const extended = patched.slice(0, base.registry.extensionAt) + registration + patched.slice(base.registry.extensionAt);
  const inspection = inspectChronicleBridge(extended);
  assert.equal(inspection.state, "patched"); assert.deepEqual(inspection.registry.extensions[0].methods, ["foundation-extra"]);
  assert.equal(applyChronicleSkysightMainBridgePatch(extended), extended);
  const result = await inertChronicleRuntime(extended).request("foundation-extra");
  assert.equal(JSON.parse(result.response.bodyJsonString).value, "registered");
  const other = 'const otherHandlers={};Object.assign(otherHandlers,{"foundation-extra":async()=>({ok:true})});';
  const wrongTarget = patched.slice(0, base.registry.extensionAt) + other + patched.slice(base.registry.extensionAt);
  assert.equal(inspectChronicleBridge(wrongTarget).registry.extensions.length, 0, "dependency cannot infer registration from a global handler/marker string");
  for (const extra of [
    'Object.assign(codexLinuxChronicleBridgeHandlers,{"chronicle-permissions":async()=>({})});',
    registration + registration,
    'codexLinuxChronicleBridgeHandlers["chronicle-permissions"]=async()=>({});',
    'const alias=codexLinuxChronicleBridgeHandlers;',
    'Object.assign(codexLinuxChronicleBridgeHandlers,{"__proto__":async()=>({})});',
    'Object.assign(codexLinuxChronicleBridgeHandlers,{...otherHandlers});',
    'const unused=()=>Object.assign(codexLinuxChronicleBridgeHandlers,{"extra":async()=>({})});',
  ]) {
    assert.equal(chronicleControllerContract(patched.slice(0, base.registry.extensionAt) + extra + patched.slice(base.registry.extensionAt)), "drifted");
  }
  assert.equal(chronicleControllerContract(patched + registration), "drifted", "registration belongs to the returned registry extension slot");
});

test("Chronicle source and normal descriptor reject disconnected native bindings and fake canonical scope", t => {
  const current = currentChronicleMainFixture(), patched = applyChronicleSkysightMainBridgePatch(current);
  const native = inspectChronicleBridge(current), canonical = inspectChronicleBridge(patched);
  const replaceSpan = (source, span, text) => source.slice(0, span.start) + text + source.slice(span.end);
  const classExpression = (source, span) => replaceSpan(source, span, "const unusedChronicleClass=" + source.slice(span.start, span.end) + ";");
  const runtimePart = recordReplayRuntimeHelperSource({ childProcessVar: 'require("node:child_process")', fsVar: 'require("node:fs")', pathVar: 'require("node:path")' });
  const registryPart = patched.slice(canonical.registry.start, canonical.registry.end);
  const serviceBody = current.slice(native.native.serviceGate.methodBodyStart, native.native.serviceGate.methodBodyEnd);
  const serviceFake = `class UnusedChronicleHost{createAppHost(i){${serviceBody}}}`;
  const actualInit = current.slice(native.native.init.start, native.native.init.end);
  const variants = {
    controllerExpression: classExpression(current, native.native.controller),
    serviceExpression: classExpression(current, native.native.service),
    unusedInit: replaceSpan(current, native.native.init, "let unusedChronicleInit=()=>" + actualInit),
    stringInit: replaceSpan(current, native.native.init, "let unusedChronicleInit=`" + actualInit + "`"),
    getterDetached: current.replace("getSkysightRecorderController:()=>Cr().skysight?xe:null", "getSkysightRecorderController:()=>null")
      .replace("return created}", 'let unusedChronicleOptions={getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null};return created}'),
    gateDetached: current.replace('chronicle:"darwin"===process.platform&&', 'unrelated:"darwin"===process.platform&&').replace("class Host{", serviceFake + "class Host{"),
    helperInString: patched.replace(runtimePart, "const unusedChronicleRuntime=`" + runtimePart + "`;"),
    helperInFunction: patched.replace(runtimePart, "function unusedChronicleRuntime(){" + runtimePart + "}"),
    registryInFunction: patched.replace(registryPart, "function unusedChronicleRegistry(){" + registryPart + "}"),
    selectorChanged: patched.replace("Object.prototype.hasOwnProperty.call(codexLinuxChronicleBridgeHandlers,t)", "Object.prototype.hasOwnProperty.call(otherHandlers,t)"),
    helperReassigned: patched + "\ncodexLinuxChronicleFetch=async()=>{};",
    escapedRunnerReassigned: patched + String.raw`;codexLinuxRecordReplayRu\u006e=async()=>({ok:true,spoof:true});`,
    escapedRunnerBraced: patched + String.raw`;codexLinuxRecordReplayR\u{75}n=async()=>({ok:true,spoof:true});`,
    escapedRegistryAlias: patched + String.raw`;const escapedAlias=codexLinuxChronicleBridgeHandle\u0072s;`,
    escapedIntrinsicWrite: patched + String.raw`;Obj\u0065ct={assign:()=>{}};`,
    helperArrayTarget: patched + ';[codexLinuxRecordReplayRun]=[async()=>({ok:true,spoof:true})];',
    helperObjectTarget: patched + ';({codexLinuxRecordReplayRun}={codexLinuxRecordReplayRun:async()=>({ok:true,spoof:true})});',
    helperRenamedObjectTarget: patched + ';({runner:codexLinuxRecordReplayRun}={runner:async()=>({ok:true,spoof:true})});',
    helperParenthesizedTarget: patched + ';(codexLinuxRecordReplayRun)=async()=>({ok:true,spoof:true});',
    helperNestedWrite: patched + ';function unusedReservedWriter(){[codexLinuxRecordReplayRun]=[async()=>({ok:true,spoof:true})]}',
    commentedHelperWrite: patched + ';codexLinuxRecordReplayRun/**/=async()=>({ok:true,spoof:true});',
    commentedArrayTarget: patched + ';[codexLinuxRecordReplayRun/**/]=[async()=>({ok:true,spoof:true})];',
    commentedParenthesizedTarget: patched + ';(codexLinuxRecordReplayRun/*target*/)=async()=>({ok:true,spoof:true});',
    intrinsicShadowed: "const Array={isArray:()=>false};" + patched,
    nativeFactoryShadow: patched.replace("class RequestWrapper{", "function codexLinuxChronicleFetch(){}class RequestWrapper{"),
    nativeFactoryHelperWrite: patched.replace("class RequestWrapper{", "codexLinuxChronicleFetch=async()=>{};class RequestWrapper{"),
    nativeFactoryRegistryWrite: patched.replace("class RequestWrapper{", 'Object.assign(codexLinuxChronicleBridgeHandlers,{"chronicle-permissions":async()=>({spoof:true})});class RequestWrapper{'),
    nestedRegistryWrite: patched + '\nclass UnusedRootHook{static{Object.assign(codexLinuxChronicleBridgeHandlers,{"chronicle-permissions":async()=>({spoof:true})})}}',
    nativeStartupShadow: patched.replace("function runMainAppStartup(e){", "function runMainAppStartup(e){let codexLinuxChronicleRequest=()=>{};"),
  };
  for (const [name, source] of Object.entries(variants)) {
    assert.notEqual(source, name.includes("Expression") || name.includes("Init") || name.startsWith("getter") || name.startsWith("gate") ? current : patched, name);
    assert.doesNotThrow(() => new (require("node:vm").Script)(source), `${name} remains valid JavaScript`);
    assert.equal(chronicleControllerContract(source), "drifted", name);
    const files = { "early-bootstrap-45-abc.js": source }, root = extractedFixture(t, files);
    const result = captureWarns(() => productionBridge(root));
    assert.equal(result.value.status, "skipped-optional", name); unchangedMainFiles(root, files);
  }
});

test("unrelated outer/factory decoys do not replace the actual Chronicle owner", () => {
  const source = currentChronicleMainFixture();
  const unrelated = 'var duplicateArchive={archiveLegacyChronicleSkill:async()=>{await archive({reason:"skysight_gate_enabled"})}};class OtherFetchWrapper{async handleRequest(e,t){return false}}';
  assert.equal(chronicleControllerContract(source + unrelated), "current");
  const last = source.lastIndexOf("}");
  const withOtherFactory = source.slice(0, last) + ',999(module,exports,require){class Hse{dependencies;cachedStatus=Empty;desiredState="stopped";status(){return false}}}' + source.slice(last);
  assert.equal(chronicleControllerContract(withOtherFactory), "current");
});

test("Chronicle production descriptor owns one transactional main inventory in standalone/dependency modes", t => {
  assert.equal(descriptors[0].phase, "extracted-app:pre-webview");
  for (const enabled of [["chronicle-skysight"], ["record-and-replay"]]) {
    const source = currentChronicleMainFixture(), root = extractedFixture(t, { "early-bootstrap.js": "const unrelated=true;", "early-bootstrap-45-abc.js": source });
    assert.equal(productionBridge(root, enabled).status, "applied");
    const output = fs.readFileSync(path.join(root, ".vite/build/early-bootstrap-45-abc.js"), "utf8");
    assert.equal(chronicleControllerContract(output), "patched");
    assert.equal(productionBridge(root, enabled).status, "already-applied");
    assert.equal(fs.readFileSync(path.join(root, ".vite/build/early-bootstrap.js"), "utf8"), "const unrelated=true;");
  }
  const root = extractedFixture(t, { "early-bootstrap-45-abc.js": currentChronicleMainFixture() });
  assert.equal(productionBridge(root, []), undefined);
});

test("Chronicle ignores inert escaped-name text and preserves ordinary reserved-name reads", () => {
  const patched = applyChronicleSkysightMainBridgePatch(currentChronicleMainFixture());
  const inert = patched + String.raw`;const inertEscapedText="codexLinuxRecordReplayRu\\u006e";/*codexLinuxRecordReplayRu\u006e*/`;
  assert.equal(chronicleControllerContract(inert), "patched");
  const reads = patched + ';const reservedReads=[codexLinuxRecordReplayRun,Object,JSON];const reservedObject={codexLinuxRecordReplayRun,Object,JSON};';
  assert.equal(chronicleControllerContract(reads), "patched");
  const commentedReads = patched + ';const reservedKey={codexLinuxRecordReplayRun/*key*/:1};const reservedValue=[codexLinuxRecordReplayRun/*read*/];';
  assert.equal(chronicleControllerContract(commentedReads), "patched");
});

for (const suffix of ["Run", "String", "Bin", "Parse"]) {
  test(`Chronicle production descriptor rejects isolated base ${suffix} helper cohort`, t => {
    for (const alreadyApplied of [false, true]) {
      const source = currentChronicleMainFixture();
      const files = {
        "early-bootstrap-45-abc.js": alreadyApplied ? applyChronicleSkysightMainBridgePatch(source) : source,
        "early-bootstrap-46-def.js": `function codexLinuxRecordReplay${suffix}(){return false}`,
      };
      const root = extractedFixture(t, files);
      const result = captureWarns(() => productionBridge(root));
      assert.equal(result.value.status, "skipped-optional");
      unchangedMainFiles(root, files);
    }
  });
}

for (const scenario of ["missing", "duplicate", "mixed", "same-id-no-needles", "same-id-exponent", "same-id-quoted", "orphan-helper", "partial"]) {
  test(`Chronicle production descriptor rejects ${scenario} cohort without writing`, t => {
    const current = currentChronicleMainFixture(), patched = applyChronicleSkysightMainBridgePatch(current);
    const files = scenario === "missing" ? { "early-bootstrap.js": "const unrelated=true;" } : { "early-bootstrap-45-abc.js": current };
    if (scenario === "duplicate") files["early-bootstrap-46-def.js"] = current;
    if (scenario === "mixed") files["early-bootstrap-46-def.js"] = patched;
    if (scenario.startsWith("same-id")) files["early-bootstrap-46-def.js"] = `exports.ids=[46],exports.modules={${scenario === "same-id-exponent" ? "8.282e4" : scenario === "same-id-quoted" ? '"82820"' : "82820"}(){return false}};`;
    if (scenario === "orphan-helper") files["early-bootstrap-46-def.js"] = 'const fragment="function codexLinuxChronicleRequest(";';
    if (scenario === "partial") files["early-bootstrap-45-abc.js"] = patched.replace("function codexLinuxChronicleRequest(", "function brokenChronicleRequest(");
    const root = extractedFixture(t, files), result = captureWarns(() => productionBridge(root));
    assert.equal(result.value.status, "skipped-optional"); assert.ok(result.warnings.length); unchangedMainFiles(root, files);
  });
}

test("Chronicle transaction restores original source after a partial write failure", t => {
  const source = currentChronicleMainFixture(), files = { "early-bootstrap-45-abc.js": source }, root = extractedFixture(t, files);
  const target = path.join(root, ".vite/build/early-bootstrap-45-abc.js"), write = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = (file, content, ...options) => {
    if (file === target && !failed) { failed = true; write(file, "partial-write"); throw Error("inert write failure"); }
    return write(file, content, ...options);
  };
  try { assert.equal(captureWarns(() => productionBridge(root)).value.status, "skipped-optional"); }
  finally { fs.writeFileSync = write; }
  assert.equal(failed, true); unchangedMainFiles(root, files);
});


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
  assert.match(patched, /const codexLinuxChronicleBridgeHandlers=\{/);
  assert.match(
    patched,
    /async handleRequest\(e,t\)\{\/\*codex-linux-chronicle-skysight-route\*\/if\(codexLinuxChronicleFetchHandler\(t\?\.url\)\)return void await codexLinuxChronicleFetch\(t,codexLinuxChronicleMessage=>this\.options\.chunkedMessageSender\.sendInlineMessageForView\(e,codexLinuxChronicleMessage\)\);if\("\/codex\/dictation-stream-connect-info"===t\.url\)/,
  );
  assert.doesNotMatch(patched, /set-remote-wsl-connections-enabled/);
  assert.match(patched, /\(N\|\|"linux"===process\.platform\)&&\(xe=new Hse\(/);
  assert.match(patched, /request:"linux"===process\.platform\?codexLinuxChronicleRequest:/);
  assert.match(patched, /reconcileComputerHistoryPluginInstallation:"linux"===process\.platform\?\(\)=>\{\}:/);
  assert.match(patched, /archiveLegacyChronicleSkill:"linux"===process\.platform\?async\(\)=>\{\}:/);
  assert.match(patched, /chronicle:"darwin"===process\.platform&&/);
  assert.doesNotMatch(patched, /chronicle:[^?]*"linux"===process\.platform/);
  assert.match(patched, /getSkysightRecorderController:\(\)=>"linux"===process\.platform\|\|Cr\(\)\.skysight\?xe:null/);
  assert.doesNotMatch(patched, /"linux-record-replay-start":async/);
  assert.doesNotMatch(patched, /"linux-record-replay-draft-skill":async/);
});

test("chronicle-skysight patches exactly one signed main-process chunk", { skip: !process.env.CODEX_SIGNED_EXTRACTED_APP }, () => {
  const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite/build");
  const chunks = fs.readdirSync(buildDir).filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name));
  assert.ok(chunks.length > 1);
  const patchedChunks = [];
  for (const name of chunks) {
    const source = fs.readFileSync(path.join(buildDir, name), "utf8");
    const { value: patched } = captureWarns(() => applyChronicleSkysightMainBridgePatch(source));
    if (patched === source) {
      assert.equal(chronicleControllerContract(source), "drifted", name);
      continue;
    }
    patchedChunks.push(name);
    assert.equal(chronicleControllerContract(source), "current", name);
    assert.equal(chronicleControllerContract(patched), "patched", name);
    const again = captureWarns(() => applyChronicleSkysightMainBridgePatch(patched));
    assert.equal(again.value, patched, name);
    assert.deepEqual(again.warnings, [], name);
    assert.doesNotThrow(() => new (require("node:vm").Script)(patched, { filename: name }), name);
  }
  assert.equal(patchedChunks.length, 1, patchedChunks.join(","));
});

test("chronicle-skysight fails closed for missing duplicate ambiguous mixed and partial contracts", () => {
  const current = currentChronicleMainFixture();
  const patched = applyChronicleSkysightMainBridgePatch(current);
  const serviceStart = current.indexOf("class $O extends");
  const serviceEnd = current.indexOf("function Cr", serviceStart);
  const duplicateService = current
    .slice(serviceStart, serviceEnd)
    .replace("class $O extends", "class $P extends");
  const controllerStart = current.indexOf("class Hse{");
  const duplicateController = current
    .slice(controllerStart, serviceStart)
    .replace("class Hse{", "class Hsf{");
  const variants = {
    retiredMinifier: "var OldController=class{};",
    missingFetchEntry: current.replace(
      '"/codex/dictation-stream-connect-info"===t.url',
      '"/codex/other-route"===t.url',
    ),
    retiredFetchEntry: current.replace(
      'throw Error("HTTP requests must use the HTTP fetch service.")',
      "return this.handleLegacyRequest(e,t)",
    ),
    missingViewResponder: current.replaceAll(
      "this.options.chunkedMessageSender.sendInlineMessageForView(e,{type:\"fetch-response\"",
      "this.options.sender.send(e,{type:\"fetch-response\"",
    ),
    missingRoute: patched.replace("/*codex-linux-chronicle-skysight-route*/", ""),
    alteredRoute: patched.replace(
      /\/\*codex-linux-chronicle-skysight-route\*\/[^;]+\)\);/,
      (route) => `;${route.replace("return void await ", "")}`,
    ),
    missingRegistry: patched.replace("const codexLinuxChronicleBridgeHandlers={", "const codexLinuxChronicleHandlers={"),
    missing: current.replace('this.request("skysightStatus")', 'this.request("statusChanged")'),
    missingRollback: current.replace("Failed to enable Chronicle and stop the recorder during rollback", "Failed"),
    duplicateController: current.slice(0, serviceStart) + duplicateController + current.slice(serviceStart),
    missingServiceGate: current.replace('chronicle:"darwin"===process.platform&&', 'chronicle:"win32"===process.platform&&'),
    mismatchedGetter: current.replace("getSkysightRecorderController:()=>Cr().skysight?xe:null", "getSkysightRecorderController:()=>Cr().skysight?ye:null"),
    missingReconciliationDependency: current.replace(
      "reconcileComputerHistoryPluginInstallation:e=>",
      "reconcileHistoryPluginInstallation:e=>",
    ),
    missingArchiveDependency: current.replace(
      "archiveLegacyChronicleSkill:async()=>",
      "archiveChronicleSkill:async()=>",
    ),
    duplicate: current + current,
    ambiguous: current.slice(0, serviceEnd) + duplicateService + current.slice(serviceEnd),
    mixed: current + patched,
    partial: patched.replace(
      'getSkysightRecorderController:()=>"linux"===process.platform||Cr().skysight?xe:null',
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
    { state: "running", is_running: true },
  ];
  const childProcess = {
    execFile(_bin, args, _options, callback) {
      calls.push(args);
      callback(null, JSON.stringify({ ok: true, ...responses.shift() }), "");
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

  evaluateChronicleFixture(patched, context);
  assert.equal(calls.length, 0, "installation/controller construction does not query or start capture");
  assert.equal(context.globalThis.controller.desiredState, "stopped");
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

  // Webview fetches reach the bridge through the desktop fetch wrapper.
  const fetchWrapper = context.globalThis.fetchWrapper;
  await fetchWrapper.handleRequest("view", {
    requestId: "status-1",
    url: "vscode://codex/linux-record-replay-skysight-status",
    body: "{}",
  });
  await fetchWrapper.handleRequest("view", {
    requestId: "bad-body",
    url: "vscode://codex/linux-record-replay-skysight-status",
    body: "{",
  });
  await fetchWrapper.handleRequest("view", { requestId: "dictation", url: "/codex/dictation-stream-connect-info" });
  await assert.rejects(
    fetchWrapper.handleRequest("view", { requestId: "proto", url: "vscode://codex/__proto__", body: "{}" }),
    /HTTP requests must use the HTTP fetch service/,
  );
  await assert.rejects(
    fetchWrapper.handleRequest("view", { requestId: "other", url: "vscode://codex/linux-record-replay-start", body: "{}" }),
    /HTTP requests must use the HTTP fetch service/,
  );
  const messages = JSON.parse(JSON.stringify(context.globalThis.viewMessages));
  assert.deepEqual(messages.map(({ view, message }) => [view, message.requestId, message.responseType, message.status]), [
    ["view", "status-1", "success", 200],
    ["view", "bad-body", "error", 500],
    ["view", "dictation", "success", 200],
  ]);
  assert.equal(JSON.parse(messages[0].message.bodyJsonString).json.state, "running");
  assert.match(messages[1].message.error, /Invalid Linux bridge request/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["skysight", "status"]);
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
            callback(null, JSON.stringify({ ok: true, ...state }), "");
          },
        };
      }
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };

  evaluateChronicleFixture(patched, context);
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
            callback(null, JSON.stringify({ ok: true, state: "running", is_running: true }), "");
          },
        };
      }
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };

  evaluateChronicleFixture(patched, context);
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

  evaluateChronicleFixture(patched, context);
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
