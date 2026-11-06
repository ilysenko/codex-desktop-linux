#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

require("./gentoo-support.test.js");

const {
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patches/runner.js");
const {
  applyLinuxRemoteControlDeviceKeyPatch,
  applyLinuxRemoteControlClientRevokeSetupResetPatch,
  applyLinuxRemoteControlClientRevocationRecoveryPatch,
  applyLinuxRemoteControlCopyPatch,
  applyLinuxRemoteControlFeatureSyncPatch,
  applyLinuxRemoteControlEnableForHostParamsPatch,
  applyLinuxRemoteControlLoadGatePatch,
  applyLinuxRemoteControlEnablementBridgePatch,
  applyLinuxRemoteMobileActiveStatusPatch,
  applyLinuxRemoteMobileAppServerRemoteControlPatch,
  applyLinuxRemoteMobileConversationHydrationPatch,
  hasLinuxRemoteMobileLocalAppServerRemoteControlPatch,
  applyLinuxRemoteMobileReasoningSummaryPatch,
  applyLinuxRemoteTerminalStatusRecoveryPatch,
  applyLinuxRemoteControlStatusReadGuardPatch,
  applyLinuxRemoteControlStatusWaitPatch,
  applyLinuxRemoteConnectionsRefreshPatch,
  applyLinuxRemoteControlSettingsUxPatch,
  applyLinuxRemoteControlVisibilityPatch,
  matchesLinuxRemoteControlEnablementBridgeContract,
  validateLinuxRemoteControlAutoConnectContract,
} = require("./patch.js");
const remoteMobilePatchDescriptors = require("./patch.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");

const REPO_ROOT = path.resolve(__dirname, "../..");
const VALID_DEVICE_KEY_NONCE = Buffer.alloc(32, 1).toString("base64url");
const VALID_DEVICE_KEY_DIGEST = Buffer.alloc(32, 2).toString("base64url");

function validEnrollmentPayload(overrides = {}) {
  return {
    type: "remoteControlClientEnrollment",
    nonce: VALID_DEVICE_KEY_NONCE,
    audience: "remote_control_client_enrollment",
    challengeId: "challenge_1",
    targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/client/enroll/finish",
    accountUserId: "user_1",
    challengeExpiresAt: "2026-09-27T12:00:00.000Z",
    clientId: "client_1",
    deviceIdentitySha256Base64url: VALID_DEVICE_KEY_DIGEST,
    ignoredExtraField: "not-signed",
    ...overrides,
  };
}

function validConnectionPayload(overrides = {}) {
  return {
    type: "remoteControlClientConnection",
    nonce: VALID_DEVICE_KEY_NONCE,
    audience: "remote_control_client_websocket",
    targetOrigin: "https://chatgpt.com",
    targetPath: "/backend-api/codex/remote/control/connect",
    accountUserId: "user_1",
    clientId: "client_1",
    scopes: ["remote_control_controller_websocket"],
    sessionId: "session_1",
    tokenExpiresAt: "2026-09-27T12:00:00.000Z",
    tokenSha256Base64url: VALID_DEVICE_KEY_DIGEST,
    ignoredExtraField: "not-signed",
    ...overrides,
  };
}

function syntheticReasoningSummaryTurnStartBundle() {
  return "async function yY(e,t,n){let s=n,D=n.latestThreadSettings,ee=n.initialParams,me=!fm(e.getHostId());let Ee=e.getDefaultFeatureOverride(vJ)===!0,De=ee?.summary??`none`;D?.summary!==void 0&&(De=D.summary),Ee&&(De=`detailed`),s.summary!==void 0&&(De=s.summary);logger.info(`Reasoning summary turn-start config resolved`,{safe:{concurrentReasoningSummariesFeatureOverrideEnabled:Ee,summary:De}});return{featureOverride:Ee,summary:De}}";
}

function syntheticCurrentReasoningSummaryTurnStartBundle() {
  return 'async function HWt(e,t,n,r,i,a,o){let s=n.request,N=a.latestThreadSettings,S=a.initialParams,C=a.configRequirements,ye=N?.summary??"none";S?.summary!==void 0&&(ye=S.summary),null!=o.reasoningSummaryOverride&&(ye=o.reasoningSummaryOverride),ye=null==C?null:C.model_reasoning_summary??ye,void 0!==s.summary&&(ye=s.summary);logger.info("Reasoning summary turn-start config resolved",{safe:{summary:ye}});return{summary:ye}}async function QWt(e,t,n,r,i,a){let b="aeon"===n.context?.threadStartKind;return await HWt(e,t,n,r,i,a,{canUseProjectlessWorkspace:!(0,gh.ZJ)(e.getHostId()),canMaterializeHostRoots:!(0,gh.ZJ)(e.getHostId())&&!0,preserveWorkspaceSandboxPolicyWithDefault:(0,gh.ZJ)(e.getHostId()),carryProjectlessRuntimeRoots:!(0,gh.ZJ)(e.getHostId()),latestUseAppServerPermissionDefault:!0,reasoningSummaryOverride:!0===e.getDefaultFeatureOverride("concurrent_reasoning_summaries")||b?"detailed":null})}';
}

test("remote mobile README assigns every descriptor to one control topology", () => {
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  const rows = [...readme.matchAll(
    /^\| `(linux-remote-[^`]+)` \| `(mobile-host|outbound-control|remote-ssh|shared-boundary)` \|/gm,
  )];
  const documented = new Map(rows.map((match) => [match[1], match[2]]));
  const descriptorIds = remoteMobilePatchDescriptors.map((descriptor) => descriptor.id);
  const expected = new Map([
    ["linux-remote-control-device-key", "outbound-control"],
    ["linux-remote-control-client-revocation-recovery", "outbound-control"],
    ["linux-remote-mobile-app-server-remote-control", "mobile-host"],
    ["linux-remote-control-load-gate", "outbound-control"],
    ["linux-remote-control-feature-sync", "shared-boundary"],
    ["linux-remote-control-visibility", "outbound-control"],
    ["linux-remote-control-copy", "shared-boundary"],
    ["linux-remote-control-settings-ux", "shared-boundary"],
    ["linux-remote-control-client-revoke-setup-reset", "mobile-host"],
    ["linux-remote-connections-refresh", "shared-boundary"],
    ["linux-remote-mobile-reasoning-summary-none", "mobile-host"],
    ["linux-remote-mobile-conversation-hydration", "mobile-host"],
    ["linux-remote-terminal-status-recovery", "mobile-host"],
    ["linux-remote-control-status-read-guard", "shared-boundary"],
    ["linux-remote-control-status-wait", "shared-boundary"],
    ["linux-remote-control-enable-for-host-params", "shared-boundary"],
    ["linux-remote-control-enablement-bridge", "shared-boundary"],
    ["linux-remote-control-auto-connect-contract", "outbound-control"],
    ["linux-remote-mobile-active-status", "mobile-host"],
  ]);

  assert.equal(documented.size, rows.length, "topology table must not repeat descriptor ids");
  assert.deepEqual([...documented.keys()].sort(), descriptorIds.sort());
  assert.deepEqual([...documented].sort(), [...expected].sort());
  assert.match(readme, /retired upstream SSH installer/);
  assert.match(readme, /`set-experimental-feature-enablement-for-host`/);
  assert.match(readme, /`refresh-remote-connections`/);
  assert.match(readme, /`setRemoteControlEnabled`/);
  assert.match(readme, /service-owned auto-connect choices/);
});

// Mirrors the rspack/SWC-minified 26.1029 main-process provider: a base class
// routes every method through getAddon() and signBytes(); its subclass inlines
// the signing payload serializer, validated by module-level helpers.
function syntheticDeviceKeyProvider({ digestValidator, noncePattern, nonceValidator, pathAlias, provider, requireVar }) {
  const base = `${provider}Base`;
  return [
    `let ${requireVar}=(0,b.createRequire)(__filename),${provider}Schema={parse:e=>e};`,
    `class ${base}{resourcesPath;addon=null;constructor(e){this.resourcesPath=e}createDeviceKey(e){return this.getAddon().createDeviceKey(e??"hardware_only")}deleteDeviceKey(e){return this.getAddon().deleteDeviceKey(e)}getDeviceKeyPublic(e){return this.getAddon().getDeviceKeyPublic(e)}signBytes(e,t){return this.getAddon().signDeviceKey(e,t)}`,
    `getAddon(){if(null==this.resourcesPath)throw Error("Device keys require resourcesPath");return null==this.addon&&(this.addon=${provider}Schema.parse(${requireVar}((0,${pathAlias}.join)(this.resourcesPath,"native","remote-control-device-key.node")))),this.addon}}`,
    `let ${noncePattern}=/^[A-Za-z0-9_-]+$/u;class ${provider} extends ${base}{async signDeviceKey(e,t){var r;let n=(r=t,Buffer.from(JSON.stringify({domain:"codex-device-key-sign-payload/v1",payload:function(e){switch(e.type){case"remoteControlClientConnection":if(${nonceValidator}(e.nonce),"remote_control_client_websocket"!==e.audience)throw Error("Invalid remote-control device-key connection audience");if(1!==e.scopes.length||"remote_control_controller_websocket"!==e.scopes[0])throw Error("Invalid remote-control device-key connection scopes");return ${digestValidator}(e.tokenSha256Base64url),{accountUserId:e.accountUserId,audience:e.audience,clientId:e.clientId,nonce:e.nonce,scopes:e.scopes,sessionId:e.sessionId,targetOrigin:e.targetOrigin,targetPath:e.targetPath,tokenExpiresAt:e.tokenExpiresAt,tokenSha256Base64url:e.tokenSha256Base64url,type:e.type};case"remoteControlClientEnrollment":if(${nonceValidator}(e.nonce),"remote_control_client_enrollment"!==e.audience)throw Error("Invalid remote-control device-key enrollment audience");return ${digestValidator}(e.deviceIdentitySha256Base64url),{accountUserId:e.accountUserId,audience:e.audience,challengeExpiresAt:e.challengeExpiresAt,challengeId:e.challengeId,clientId:e.clientId,deviceIdentitySha256Base64url:e.deviceIdentitySha256Base64url,nonce:e.nonce,targetOrigin:e.targetOrigin,targetPath:e.targetPath,type:e.type}}}(r)}),"utf8"));return{...await this.signBytes(e,n),signedPayloadBase64:n.toString("base64")}}}`,
    `function ${nonceValidator}(e){if(!${noncePattern}.test(e)||Buffer.from(e,"base64url").length<32)throw Error("Invalid remote-control device-key nonce")}`,
    `function ${digestValidator}(e){if(!${noncePattern}.test(e)||32!==Buffer.from(e,"base64url").length)throw Error("Invalid remote-control device-key SHA-256 digest")}`,
  ].join("");
}

function syntheticMainBundle() {
  return [
    'let i=require("node:path"),o=require("node:fs"),s=require("node:crypto"),h=require("node:child_process"),b={createRequire:()=>()=>({})};',
    syntheticDeviceKeyProvider({
      digestValidator: "DV",
      noncePattern: "CV",
      nonceValidator: "NV",
      pathAlias: "i",
      provider: "wV",
      requireVar: "bV",
    }),
    "function Owner(){this.deviceStorage=null,this.remoteControlDeviceKeyClient=new wV((0,tY.b)({resourcesPath:null})),this.executionHostRegistry={}}var tY={b:e=>e.resourcesPath};",
  ].join("");
}

function syntheticCurrentMainBundle() {
  return [
    'let i=require("node:path"),o=require("node:fs"),s=require("node:crypto"),h=require("node:child_process"),b={createRequire:()=>()=>({})};',
    syntheticDeviceKeyProvider({
      digestValidator: "efo",
      noncePattern: "efi",
      nonceValidator: "efa",
      pathAlias: "i",
      provider: "efs",
      requireVar: "efn",
    }),
    "function Owner(){this.remoteControlDeviceKeyClient=new efs(null),this.executionHostRegistry={}}",
  ].join("");
}

function syntheticCryptoAliasCollisionMainBundle() {
  return [
    'let a=require("node:path"),o=require("node:fs"),c=require("node:crypto"),h=require("node:child_process"),b={createRequire:()=>()=>({})};',
    syntheticDeviceKeyProvider({
      digestValidator: "efo",
      noncePattern: "efi",
      nonceValidator: "efa",
      pathAlias: "a",
      provider: "efs",
      requireVar: "efn",
    }),
    "function Owner(){this.remoteControlDeviceKeyClient=new efs(null),this.executionHostRegistry={}}",
  ].join("");
}

function captureWarns(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function createPatchedDeviceKeyClient(configHome, moduleOverrides = {}, processEnv = {}) {
  const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticMainBundle());
  const context = {
    Buffer,
    clearTimeout,
    Date,
    Error,
    JSON,
    Promise,
    console,
    __filename: path.join(path.resolve(configHome), "early-bootstrap-916-2f6483d5bfd826f1.js"),
    module: { exports: {} },
    process: {
      env: { XDG_CONFIG_HOME: configHome, ...processEnv },
      getuid: typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
      pid: process.pid,
      platform: "linux",
    },
    require: (moduleName) => moduleOverrides[moduleName] ?? require(moduleName),
    setTimeout,
  };
  vm.runInNewContext(`${patched};module.exports=new Owner().remoteControlDeviceKeyClient;`, context);
  return context.module.exports;
}

function createSafeStorage({ backend = "gnome_libsecret", decryptError = null, encryptError = null } = {}) {
  const calls = { decrypt: [], encrypt: [] };
  return {
    calls,
    safeStorage: {
      decryptString(ciphertext) {
        calls.decrypt.push(Buffer.from(ciphertext));
        if (decryptError != null) throw decryptError;
        const encoded = Buffer.from(ciphertext).toString("utf8");
        assert.match(encoded, /^encrypted:/u);
        return encoded.slice("encrypted:".length);
      },
      encryptString(plaintext) {
        calls.encrypt.push(plaintext);
        if (encryptError != null) throw encryptError;
        return Buffer.from(`encrypted:${plaintext}`, "utf8");
      },
      getSelectedStorageBackend: () => backend,
      isEncryptionAvailable: () => true,
    },
  };
}

function findExecutableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function remoteControlKeyStorePaths(configHome) {
  const directory = path.join(configHome, "codex-desktop", "remote-control-device-keys");
  const store = path.join(directory, "remote-control-device-keys-v1.json");
  return { directory, lock: `${store}.lock`, store };
}

// 26.1027 throws 403 responses with the bare server detail (em1), so only the
// prefixed 403 key-material message is checked upstream.
function syntheticRecoverableErrorPredicateBundle() {
  return 'async function Bd(e){let p;try{await e()}catch(t){if(!((p=t)instanceof Error&&("Remote control request failed (404): Remote-control client not found"===p.message||"Remote-control client has been revoked"===p.message||"Remote control request failed (401): Remote-control client enrollment is incomplete"===p.message||"Remote control request failed (403): Remote-control client key material missing"===p.message)))throw t;return"recovered"}return"ok"}';
}

// The remote-control loader gate module of the signed webview chunk.
function syntheticRemoteConnectionVisibilityBundle() {
  return rspackChunk(24191, 'PIwo(e,t,n){var o=n("statsig");let d={key:"features.remote_connections"};function c(){return!0}function p(){return(0,o.Zj)("1042620455")}function h(){return[]}n.d(t,{Ik:()=>c,mC:()=>p,mw:()=>h})}');
}

// The main-process experimental feature enablement sync of the signed chunk.
function syntheticAppMainFeatureSyncBundle() {
  return '"use strict";exports.ids=[45],exports.modules={57240(e,t,r){class Sync{constructor(e){this.disposed=!1,this.evaluations=e}async sendEnablement(e,t){let r=await this.evaluations.readExecutionAssignments(),n=r.values.experimentalFeatureGates,i=function(e,t){let r={memories:!1};return r.remote_plugin=t,r}(r.defaultEnableFeatures,n.curatedRemoteMarketplace);i.mcp_connection_sharing=n.shareCodexAppTools??!1;let s=()=>{};let a=!1;try{let t=await e.connection.sendAppServerRequest("experimentalFeature/enablement/set",{enablement:i},s);a=null!=t.enablement.daybreak_program_propagation}catch(e){throw e}return a}}t.Sync=Sync}};';
}

function syntheticCurrentVisibilityBundle() {
  return "function Et({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)}export{Et as t};";
}

function syntheticCurrentUsePluginVisibilityBundle() {
  return "function ke({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}export{ke as l};";
}

function syntheticMobileSetupDialogComputerUseBundle() {
  return "let y={id:\"codexMobile.setupDialog.connected.computerUse.description\",defaultMessage:\"Let ChatGPT control apps on your Mac\",description:\"Description for enabling Computer Use after mobile setup\"};";
}

function syntheticRemoteConnectionsSettingsCopyBundle() {
  return [
    syntheticCurrentVisibilityBundle(),
    "let a={id:\"settings.remoteConnections.tabs.controlThisMac\",defaultMessage:\"Control this Mac\",description:\"Tab label for settings that let other devices control this computer\"};",
    "let b={id:\"settings.remoteControlConnections.devices.title\",defaultMessage:\"Devices that can control this Mac\",description:\"Header title for devices that can control this Mac\"};",
    "let c={id:\"settings.remoteConnections.accessOtherDevices.header.title\",defaultMessage:\"Devices you can control from this Mac\",description:\"Header title for the devices this computer can access\"};",
    "let d={id:\"settings.remoteConnections.ssh.header.title\",defaultMessage:\"SSH connections from this Mac\",description:\"Header title for SSH connections from this Mac\"};",
    "let e={id:\"settings.remoteControlConnections.keepAwake.title\",defaultMessage:\"Keep this Mac awake\",description:\"Keep awake title\"};",
    "let f={id:\"settings.remoteConnections.connectedDevices.description\",defaultMessage:\"iPhone Pro and Samsung Galaxy devices connected to ChatGPT on a Mac\",description:\"Connected device description\"};",
  ].join("");
}

function syntheticMobileSetupDialogCopyBundle() {
  return [
    "let a={id:\"codexMobile.setupDialog.connected.lockedComputerUse.title\",defaultMessage:\"Use your Mac apps while locked\",description:\"Title for enabling Locked Computer Use after mobile setup\"};",
    "let b={id:\"codexMobile.setupDialog.connected.lockedComputerUse.description\",defaultMessage:\"Control Mac apps from your phone\",description:\"Description for enabling Locked Computer Use after mobile setup\"};",
    "let c={id:\"codexMobile.setupDialog.connected.computerUse.description\",defaultMessage:\"Let Codex control the apps on your Mac\",description:\"Description for enabling Computer Use after mobile setup\"};",
    "let d={id:\"codexMobile.setupPage.initial.heading\",defaultMessage:\"Connect your phone to this Mac\",description:\"Heading for Codex mobile setup\"};",
  ].join("");
}

// The SSH bootstrap chunk inlines the remote base args with `app-server`;
// it is not the local Desktop transport.
function syntheticLegacyWslAppServerLaunchBundle() {
  return 'exports.ids=[339],exports.modules={6226(e,t,n){"use strict";function o(e){return c(e,["-c","features.code_mode_host=true","app-server","--analytics-default-enabled"])}function c(e,t){return t}}};';
}

function syntheticCurrentLocalAppServerLaunchBundle() {
  return [
    'let O="Codex Desktop",A=["-c","features.code_mode_host=true"],R=[{configKey:"chatgpt_base_url",envVar:"CODEX_APP_SERVER_CHATGPT_BASE_URL"},{configKey:"openai_base_url",envVar:"CODEX_APP_SERVER_OPENAI_BASE_URL"}];',
    'function uB(){let e=R.flatMap(({configKey:e,envVar:t})=>{let r=process.env[t]?.trim();return null==r||""===r?[]:["-c",`${e}=${JSON.stringify(r)}`]});return 0===e.length?[...A,"app-server","--analytics-default-enabled"]:["app-server",...A,...e,"--analytics-default-enabled"]}',
  ].join("");
}

function syntheticStartupCommandAppServerLaunchBundle() {
  return [
    syntheticCurrentLocalAppServerLaunchBundle(),
    'function bc(e,t=[]){let r={executablePath:"codex",args:uB()};return{executablePath:r.executablePath,args:[...r.args,...e.startupCommand?.args??[],...t.flatMap(e=>["-c",e])]}}',
  ].join("");
}

// A local launch module wrapped as it ships in an rspack main-process chunk.
function syntheticCurrentLocalAppServerLaunchChunk() {
  return `exports.ids=[824],exports.modules={10824(e,t,r){"use strict";r.d(t,{uB:()=>uB});${syntheticCurrentLocalAppServerLaunchBundle()}}};`;
}

function syntheticCurrentSettingsRefreshBundle() {
  return [
    'var Jn="[remote-connections/settings]",Xn=[],Zn=[];',
    'function Qn(){let ge=me(),et=!1,ne=B,label={id:"settings.remoteConnections.refresh"},ft=(0,Z.useEffectEvent)(async e=>{if(!et)try{await ne(e)}catch(e){if(e instanceof DOMException&&"AbortError"===e.name)return;M.debug(Jn+" auto_refresh_failed",{safe:{},sensitive:{error:e}})}});',
    "let xn=()=>{let e=null,t=!1,n=async()=>{t||(t=!0,e=new AbortController,await (async()=>{await ft(e.signal)})().finally(()=>{e=null,t=!1}))},r=window.setInterval(()=>{n()},15e3);return()=>{e?.abort(),window.clearInterval(r)}};return xn}",
  ].join("");
}

// rspack webview chunk: module factories keyed by hashed ids, imports bound by
// the factory's require parameter.
function rspackChunk(id, modules) {
  return `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];export const __webpack_modules__={${modules}};`;
}

// Runs one module factory of a chunk like the rspack runtime would.
function loadRspackModule(source, moduleId, imports = {}, globals = {}) {
  const sandbox = { ...globals };
  vm.runInNewContext(source.replace(/export const /g, "var "), sandbox);
  const exports = {};
  const load = (id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected import ${id}`);
    return imports[id];
  };
  load.d = (target, getters, values = {}) => {
    for (const [key, getter] of Object.entries(getters)) Object.defineProperty(target, key, { get: getter, enumerable: true });
    Object.assign(target, values);
  };
  sandbox.__webpack_modules__[moduleId]({}, exports, load);
  return exports;
}

// The settings page shadows the app-services import binding (`T`) inside the
// component, as the signed bundle does.
function syntheticCurrentRevokeSetupResetBundle() {
  return rspackChunk(14625, [
    'GrdY(e,t,n){n.d(t,{Settings:()=>ni});var T=n("GaA7"),k=n("track");',
    'async function np(e){let t=T.appServices.remoteConnections;if(null==t)throw Error("Remote connections are unavailable");return t.setAutoConnect(e)}',
    'function ni(e){let t,n,T,{snapshot:a,store:$}=e,ec=a.localClientId,x={localRemoteControlClientId:ec},ej=a.query,',
    'Se={onRevoked:e=>{ej.setData(t=>t?.filter(t=>t.clientId!==e)),ej.invalidate()},onRevokeResult:e=>{(0,k.yy)($,"revoke",{result:e})}},',
    'toast={id:"remote-control-client-revoke-success"};return{handler:Se.onRevoked,query:ej,x}}}',
  ].join(""));
}

function loadRevokeSettings(patched, data) {
  const writes = [];
  const query = {
    data,
    setData(update) { this.data = update(this.data); },
    invalidate() { this.invalidated = true; },
  };
  const { Settings } = loadRspackModule(patched, "GrdY", {
    GaA7: { appServices: { remoteConnections: {}, applicationState: { write: (key, value) => { writes.push([key, value]); return Promise.resolve({ success: true }); } } } },
    track: { yy() {} },
  });
  const { handler } = Settings({ snapshot: { localClientId: "desktop_1", query }, store: {} });
  return { handler, query, writes };
}

// The outbound tab gate of the remote connections settings page.
function syntheticOutboundTabGateBundle() {
  return 'function Uo(){let l=(0,G.Zj)("782640499"),u=(0,G.Zj)(on),z=Ge(),B=!l,Se=null==f,Ce=null==p;return B&&z}';
}

function syntheticCurrentAppServerManagerSignalsBundle() {
  return [
    "function Of({resumeState:a,threadRuntimeStatus:o,threadSummary:r}){return{threadRuntimeStatus:a===`needs_resume`||o?.type===`notLoaded`?r?.threadRuntimeStatus??o??null:o??r?.threadRuntimeStatus??null,resumeState:a}}",
    "class T{onNotification(e){this.resumeNotificationBuffer.buffer(e);this.threadStartedNotificationDeferral.bufferNotification(e)}}",
  ].join("");
}

function syntheticCurrentConversationHydrationBundle() {
  return [
    "function qz(e){return e.threadId??null}function Y(e){return e}function mz(){return[]}function Jnn(e){return e}function QB(){return{}}function Ztn(){}",
    "class NotificationBuffer{buffers=new Map;begin(e){this.buffers.has(e)||this.buffers.set(e,[])}buffer(e,t){let r=this.buffers.get(qz(e.notification.params));return r!=null&&(r.push({delivery:e,shouldIgnore:t}),!0)}bufferRequest(e){let r=this.buffers.get(qz(e.params));return r!=null&&(r.push({request:e}),!0)}release(e,t,n,r){let a=this.buffers.get(e);this.buffers.delete(e);for(let e of a??[])e.request?r(e.request):n(e.delivery,e.shouldIgnore)}discard(e){this.buffers.delete(e)}}",
    "class HydrationLifecycle{manager;context;schedule;buffer=new NotificationBuffer;pending=new Map;constructor(e,t,n){this.manager=e,this.context=t,this.schedule=n}bufferNotification(e,t){let{notification:n}=e,r=qz(n.params);if(r==null)return!1;let i=Y(r),a=this.pending.get(i);return null!=a?(a.ignored.add(t),this.buffer.buffer(e,t)):!(!this.manager.isCloudHost||\"turn/started\"!==n.method&&\"turn/completed\"!==n.method||this.context.threadStore.conversations.has(i)||this.context.threadStore.isConversationSuppressed(i))&&(this.beginDiscovery(i,t),this.buffer.buffer(e,t))}bufferRequest(e,t,n){if(e.method===`item/tool/requestSetupCodexContextPicker`||e.method===`item/tool/call`&&Jnn(e.params)?.status!==`pending`||e.method===`mcpServer/elicitation/request`&&QB(e.params,t.isOpenAIFormElicitationsEnabled?.()??!0,n.parseUrl)==null)return!1;let r=qz(e.params);if(r==null)return!1;let i=Y(r),a=this.pending.get(i);return a==null?!this.context.threadStore.conversations.has(i)&&!this.context.threadStore.isConversationSuppressed(i)&&this.beginDiscovery(i,void 0):a.ignored.add(void 0),this.buffer.bufferRequest(e)}discard(e){this.pending.get(e)?.cancelRetry?.(),this.pending.delete(e),this.buffer.discard(e)}clear(){for(let e of this.pending.keys())this.discard(e)}beginDiscovery(e,t){let n={ignored:new Set([t]),cancelRetry:null};this.pending.set(e,n),this.buffer.begin(e),this.hydrate(e,n,!1)}hydrate(e,t,n){let r=()=>this.pending.get(e)===t&&!this.context.threadStore.isConversationSuppressed(e)&&Array.from(t.ignored).some(e=>!e?.());if(this.pending.get(e)===t){if(!r()){this.discard(e);return}this.context.threadStore.hydrateActiveThread(e,r).then(i=>{if(this.pending.get(e)===t){if(!r())this.discard(e);else if(i){this.pending.delete(e);let t=this.manager.getConversationOrThrow(e);this.buffer.release(e,mz(t,this.context.turnMergePolicy),({notification:e,automationCapability:t,receivedAtMs:n},r)=>this.manager.onNotification(e.method,e.params,t,r,n),e=>this.manager.onRequest(e),t=>Ztn(this.manager,{method:`serverRequest/resolved`,params:{threadId:e,requestId:t.id}},t))}else n?this.discard(e):t.cancelRetry=this.schedule(()=>this.hydrate(e,t,!0),1e3)}}).catch(n=>{this.pending.get(e)===t&&this.discard(e),this.manager.logger.debug(\"Failed to discover thread from event\",{safe:{},sensitive:{conversationId:e,error:n}})})}}}",
  ].join("");
}

// Three modules of the signed chunk: the terminal status reducer with its
// list-state caller, the sidebar caller, and the pending-request resolver.
function syntheticRemoteTerminalStatusBundle() {
  return rspackChunk(24191, [
    'EU9a(e,t,n){var a=n("jotai"),o=n("state"),u=n("work");let h=(0,a.i1)(0,({conversationId:e,hostId:t},{get:n})=>{let r=n(o.pC,{conversationId:e,hostId:t}),i=n(o.ok,{hostId:t,threadId:e}),a=i?.resumeState,s=i?.summary.threadRuntimeStatus;return m({hasInProgressOwnedWork:n(u.Oz,e),isResponseInProgress:i?.isResponseInProgress??null,resumeState:a??(null==r?null:"needs_resume"),threadRuntimeStatus:"needs_resume"===a||s?.type==="notLoaded"?r?.threadRuntimeStatus??s??null:s??r?.threadRuntimeStatus??null,latestTurnHasSystemError:i?.latestTurnError!=null})});function m({hasInProgressOwnedWork:e,isResponseInProgress:t,latestTurnHasSystemError:n,resumeState:r,threadRuntimeStatus:i}){return e?"loading":i?.type==="systemError"?"error":i?.type==="active"?"loading":"needs_resume"===r?"idle":n?"error":!0===t?"loading":"idle"}n.d(t,{sX:()=>m},{h})}',
    'e9KY(e,t,n){var a=n("jotai"),s=n("state"),l=n("EU9a"),u=n("sZJm");let A=(0,a.i1)(0,(e,{get:t})=>{let{hostId:n,threadId:r}=e,i=t(s.pC,{conversationId:r,hostId:n}),a=t(s.ok,e),o=a?.resumeState,d=a?.summary.threadRuntimeStatus,c=(0,l.sX)({hasInProgressOwnedWork:!1,isResponseInProgress:a?.isResponseInProgress??null,resumeState:o??(null==i?null:"needs_resume"),threadRuntimeStatus:"needs_resume"===o||d?.type==="notLoaded"?i?.threadRuntimeStatus??d??null:d??i?.threadRuntimeStatus??null,latestTurnHasSystemError:a?.latestTurnError!=null}),p=t(u.Z,{hostId:n,conversationId:r});return{type:p?.kind==="input"&&p.blocking?"idle":c}});n.d(t,{},{A})}',
    'sZJm(e,t,n){var a=n("jotai"),s=n("threads"),l=n("approvals");let f=(0,a.i1)(0,({conversationId:e,hostId:t},{get:n})=>{let r=n(s.hF,{hostId:t,threadId:e}),i=function({mcpServerElicitationKind:e,pendingRequestType:t,requests:n,resumeState:r,threadRuntimeStatus:i,userInputRequestId:a}){if(null==n||null==r)return null;return"needs_resume"===r?i?.type==="active"&&i.activeFlags.includes("waitingOnApproval")&&(0,l.PZ)(n)?{blocking:!0,kind:"approval",source:m(t)}:i?.type==="active"&&i.activeFlags.includes("waitingOnUserInput")?{autoResolution:null,blocking:!0,kind:"input",requestId:a,source:"userInput"}:null:(0,l.w_)(t)?{blocking:!0,kind:"approval",source:m(t)}:"userInput"===t?{autoResolution:null,blocking:!0,kind:"input",requestId:a,source:"userInput"}:null}({mcpServerElicitationKind:null,pendingRequestType:r?.pendingRequest?.kind??null,requests:r?.requests??null,resumeState:r?.resumeState??null,threadRuntimeStatus:r?.threadRuntimeStatus??null,userInputRequestId:r?.pendingRequest?.userInputRequestId??null});return i});function m(e){return"approval"}n.d(t,{Z:()=>f})}',
  ].join(","));
}

function syntheticAppServerManagerStatusBundle() {
  return [
    "var o={v:{error(){}}},i={C:e=>ou(e)},a={P:e=>e},u={};function h(e,t,n){return e.set(u,t,n)}",
    'function p(e,t,n,r){let s;if((0,i.C)(t))return()=>{};let l=new AbortController,d=()=>!l.signal.aborted&&(r?.()??!0),c=e.get(u,t),p=n.subscribe({type:"notification",key:{hostId:t},methods:"remoteControl/status/changed",listener:({params:n})=>{d()&&h(e,t,n)}}),f=()=>{l.signal.aborted||(l.abort(),p[Symbol.dispose](),s?.[Symbol.dispose]())};return p.onRpcBroken(f),p.then(e=>{d()?(s=e,e.onRpcBroken(f)):e[Symbol.dispose]()},f),(0,a.P)(n.sendRequest("remoteControl/status/read",void 0),l.signal).then(n=>{e.get(u,t)===c&&d()&&h(e,t,n)}).catch(e=>{d()&&o.v.error("Failed to read remote-control status",{safe:{},sensitive:{error:e}})}),f}',
  ].join("");
}

function syntheticCurrentStatusWaitBundle() {
  return [
    'function p(e,t,n,r){return n.subscribe({type:"notification",key:{hostId:t},methods:"remoteControl/status/changed",listener:()=>{}})}',
    'function m(e,t,{ignoreCurrentError:n=!1}={}){return new Promise((n,r)=>{let a,s=!1,o=e=>{s||(s=!0,clearTimeout(l),a?.(),e instanceof Error?r(e):n(e))},l=setTimeout(()=>{o(Error("Timed out waiting for remote control to connect"))},5e3);a=e.watch(()=>{}),s&&a()})}',
  ].join("");
}

function syntheticAppMainActiveStatusBundle() {
  return [
    'let o={active:"Subscribed: active",follower:"Subscribed: follower",inactive:"Subscribed: idle","needs-resume":"Needs resume","read-only":"Read-only snapshot"};',
    'function ei(e){return o[function({latestTurnStatus:e,resumeState:t,streamRole:n,threadRuntimeStatus:a}){return null==n?"needs_resume"===t?"needs-resume":"read-only":"follower"===n.role?"follower":a?.type==="active"||"inProgress"===e?"active":"inactive"}(e)]}',
  ].join("");
}

function syntheticAppMainEnablementBridgeBundle() {
  return [
    'var su={Qg:"2055603567"};function p4(){let e,t,n,a,i=(0,c.c)(10),{checkGate:s,isLoading:r}=(0,ed.cn)();i[0]!==s?(e=s(su.Qg),i[0]=s,i[1]=e):e=i[1];let o=e;i[2]!==s||i[3]!==o?(t=s("1042620455")||o,i[2]=s,i[3]=o,i[4]=t):t=i[4];let l=t;return i[5]!==r||i[6]!==o||i[7]!==l?(n=()=>{let e=na.appServices.remoteConnections;r||null==e||e.setRemoteControlEnabled({enabled:l,oneToOnePairingInAppEnabled:o}).catch(e=>{y.v.warning("[remote-connections/gate-bridge] sync_failed",{safe:{remoteControlConnectionsEnabled:l},sensitive:{error:e}})})},a=[r,o,l],i[5]=r,i[6]=o,i[7]=l,i[8]=n,i[9]=a):(n=i[8],a=i[9]),(0,u.useEffect)(n,a),null}',
  ].join("");
}

// The host toggle request module (embedded in every chunk offering the toggle).
function syntheticCurrentAppMainEnablementBridgeBundle() {
  return [
    syntheticAppMainEnablementBridgeBundle(),
    'async function s(e,t,n,{shouldApplyStatus:r=()=>!0}={}){let o=e.get(i.AP,t),l=await (0,a.V)(e,t).sendRequest(n?"remoteControl/enable":"remoteControl/disable",null),c=e.get(i.AP,t);return!r()||(0,i.Lt)(e,t,l),l}',
  ].join("");
}

function syntheticAutoConnectServiceBundle() {
  return "class ConnectionsService{constructor(e){this.connections=e}setAutoConnect(e){return this.connections.setRemoteConnectionAutoConnect(e.hostId,e.autoConnect)}}";
}

function syntheticAutoConnectSettingsCallerBundle() {
  return 'async function np(e){let t=T.appServices.remoteConnections;if(null==t)throw Error("Remote connections are unavailable");return t.setAutoConnect(e)}';
}

function withTempFeatureRoot(enabled, fn) {
  // Mirror the repository layout so the copied patch module resolves the
  // shared patch helpers it requires through ../../scripts.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-feature-test-"));
  const root = path.join(base, "linux-features");
  try {
    fs.mkdirSync(root);
    fs.symlinkSync(path.join(REPO_ROOT, "scripts"), path.join(base, "scripts"));
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(__dirname, path.join(root, "remote-mobile-control"), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function applyPatchTwice(patchFn, source, ...args) {
  const patched = patchFn(source, ...args);
  assert.equal(patchFn(patched, ...args), patched);
  return patched;
}

function withFeatureRootEnv(root, fn) {
  const previous = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = previous;
    }
  }
}

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

const COLD_START_TEST_ENV_KEYS = [
  "CODEX_HOME",
  "CODEX_LINUX_APP_DIR",
  "CODEX_REMOTE_CONTROL_CODEX_PATH",
  "CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED",
  "CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS",
  "CODEX_REMOTE_CONTROL_FORCE_COLD_START_DAEMON",
  "TEST_SYSTEMCTL_ACTIVE_STATUS",
  "TEST_SYSTEMCTL_CAT_STATUS",
  "TEST_SYSTEMCTL_ENABLED_STATUS",
];

function coldStartTestEnv(env) {
  const result = { ...process.env };
  for (const key of COLD_START_TEST_ENV_KEYS) {
    delete result[key];
  }
  return { ...result, ...env };
}

function runColdStartHook(env) {
  const tempBin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-bin-"));
  try {
    const systemctl = path.join(tempBin, "systemctl");
    fs.writeFileSync(systemctl, [
      "#!/usr/bin/env sh",
      "case \"$*\" in",
      "  '--user is-active --quiet codex-remote-control.service') exit \"${TEST_SYSTEMCTL_ACTIVE_STATUS:-3}\" ;;",
      "  '--user is-enabled --quiet codex-remote-control.service') exit \"${TEST_SYSTEMCTL_ENABLED_STATUS:-3}\" ;;",
      "  '--user cat codex-remote-control.service') exit \"${TEST_SYSTEMCTL_CAT_STATUS:-3}\" ;;",
      "esac",
      "exit 3",
      "",
    ].join("\n"));
    fs.chmodSync(systemctl, 0o755);

    const childEnv = coldStartTestEnv(env);
    childEnv.PATH = `${tempBin}${path.delimiter}${childEnv.PATH ?? ""}`;
    return spawnSync("bash", [path.join(__dirname, "cold-start-hook.sh"), "--run-main"], {
      env: childEnv,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(tempBin, { recursive: true, force: true });
  }
}

function runStageHook(env) {
  return spawnSync("bash", [path.join(__dirname, "stage.sh")], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function writeDesktopAppServerRemoteControlMarker(appDir) {
  const marker = path.join(appDir, ".codex-linux", "desktop-app-server-remote-control-enabled");
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, "version=1\nowner=desktop\n");
}

test("remote mobile control feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);
  });
});

test("remote mobile control feature exposes its stage hook when enabled", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), [
      {
        id: "remote-mobile-control",
        path: path.join(root, "remote-mobile-control", "stage.sh"),
      },
    ]);
  });
});

test("remote mobile stage hook preserves official single-instance and browser RPC clients", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const featureMarker = path.join(installDir, ".codex-linux", "remote-mobile-control-enabled");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");
    const coldStartHook = path.join(installDir, ".codex-linux", "cold-start.d", "remote-mobile-control");
    const browserClient = path.join(installDir, "resources", "plugins", "openai-bundled", "plugins", "chrome", "scripts", "browser-client.mjs");
    const browserSource = Buffer.from("export async function setupBrowserRuntime(options){const runtime=globalThis.nodeRepl;return runtime.rpc('browser',{method:'setup',params:options})}\n");
    fs.mkdirSync(path.dirname(browserClient), { recursive: true });
    fs.writeFileSync(browserClient, browserSource);
    const env = {
      ARCH: "x64",
      CODEX_UPSTREAM_APP_DIR: path.join(tempRoot, "upstream-app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    };

    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "early-bootstrap-824-3c24dda6dba622ec.js"),
      applyLinuxRemoteMobileAppServerRemoteControlPatch(syntheticCurrentLocalAppServerLaunchBundle()),
    );

    const featuresConfigPath = path.join(tempRoot, "features.json");
    fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: ["remote-mobile-control"] }));
    stageEnabledLinuxFeatureInstall(installDir, {
      featuresRoot: path.join(REPO_ROOT, "linux-features"),
      featuresConfigPath,
    });
    const first = runStageHook(env);
    const second = runStageHook(env);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(fs.readFileSync(browserClient), browserSource);
    assert.doesNotMatch(first.stderr + second.stderr, /Chrome|browser-client|bridge patch/);

    assert.equal(fs.readFileSync(featureMarker, "utf8"), "remote-mobile-control\n");
    assert.equal(fs.readFileSync(marker, "utf8"), "version=1\nowner=desktop\n");
    assert.equal(fs.existsSync(path.join(installDir, ".codex-linux", "single-instance-required")), false);
    assert.equal(fs.statSync(coldStartHook).mode & 0o777, 0o755);
    assert.equal(
      fs.readFileSync(coldStartHook, "utf8"),
      fs.readFileSync(path.join(__dirname, "cold-start-hook.sh"), "utf8"),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile stage hook removes a stale ownership marker when only the legacy WSL patch marker exists", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");

    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(path.join(buildDir, "early-bootstrap-824-3c24dda6dba622ec.js"), "globalThis.codexLinuxRemoteMobileAppServerArgs=true;");
    fs.writeFileSync(marker, "stale\n");

    const result = runStageHook({
      ARCH: "x64",
      CODEX_UPSTREAM_APP_DIR: path.join(tempRoot, "upstream-app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(marker), false);
    assert.match(result.stderr, /Desktop app-server remote-control marker not found/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile stage hook rejects an incomplete local Desktop patch marker", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");

    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "src.js"), "globalThis.codexLinuxRemoteMobileLocalAppServerArgs=true;");

    const result = runStageHook({
      ARCH: "x64",
      CODEX_UPSTREAM_APP_DIR: path.join(tempRoot, "upstream-app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(marker), false);
    assert.match(result.stderr, /Desktop app-server remote-control marker not found/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile stage hook replaces an ownership marker symlink without following it", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");
    const target = path.join(tempRoot, "must-not-change");

    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "early-bootstrap-824-3c24dda6dba622ec.js"),
      applyLinuxRemoteMobileAppServerRemoteControlPatch(syntheticCurrentLocalAppServerLaunchBundle()),
    );
    fs.writeFileSync(target, "preserved\n");
    fs.symlinkSync(target, marker);

    const result = runStageHook({
      ARCH: "x64",
      CODEX_UPSTREAM_APP_DIR: path.join(tempRoot, "upstream-app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(target, "utf8"), "preserved\n");
    assert.equal(fs.lstatSync(marker).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(marker, "utf8"), "version=1\nowner=desktop\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook leaves the user's interactive Codex CLI untouched", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const userManagedCodex = path.join(tempRoot, "brew", "bin", "codex");
    const userCodex = path.join(home, ".local", "bin", "codex");

    fs.mkdirSync(path.dirname(userManagedCodex), { recursive: true });
    fs.mkdirSync(path.dirname(userCodex), { recursive: true });
    fs.writeFileSync(userManagedCodex, "#!/usr/bin/env sh\nexit 0\n");
    fs.chmodSync(userManagedCodex, 0o755);
    fs.symlinkSync(userManagedCodex, userCodex);

    const result = runColdStartHook({
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readlinkSync(userCodex), userManagedCodex);
    assert.doesNotMatch(
      fs.readFileSync(path.join(__dirname, "cold-start-hook.sh"), "utf8"),
      /chatgpt\.com\/codex\/install\.sh|CODEX_INSTALL_DIR|packages\/standalone/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook skips daemon when Desktop app-server owns remote-control", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const appDir = path.join(tempRoot, "package", "share", "codex-desktop", "app");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(callsLog), false);
    assert.match(result.stdout, /owner: desktop \(app-server launches with remote-control enabled\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook rejects an invalid Desktop owner marker", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const appDir = path.join(tempRoot, "app");
    const bundledCodex = path.join(appDir, "resources", "codex");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(path.dirname(bundledCodex), { recursive: true });
    fs.mkdirSync(path.join(appDir, ".codex-linux"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, ".codex-linux", "desktop-app-server-remote-control-enabled"),
      "desktop-app-server-remote-control\n",
    );
    fs.writeFileSync(bundledCodex, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\n`);
    fs.chmodSync(bundledCodex, 0o755);

    const result = runColdStartHook({ CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDir, HOME: home });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Ignoring invalid remote mobile control Desktop owner marker/);
    assert.match(result.stdout, /owner: bundled official Codex fallback/);
    assert.equal(fs.readFileSync(callsLog, "utf8"), "remote-control start\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook keeps explicit disablement ahead of the Desktop marker", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const appDir = path.join(tempRoot, "app");
    fs.mkdirSync(home, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /owner: disabled by CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook keeps an enabled inactive systemd owner without starting fallback", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(home, { recursive: true });

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
      TEST_SYSTEMCTL_ACTIVE_STATUS: "3",
      TEST_SYSTEMCTL_ENABLED_STATUS: "0",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /owner: systemd \(codex-remote-control.service is configured but inactive\)/);
    assert.equal(fs.existsSync(callsLog), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook reports an active systemd owner", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    fs.mkdirSync(home, { recursive: true });

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      HOME: home,
      TEST_SYSTEMCTL_ACTIVE_STATUS: "0",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /owner: systemd \(codex-remote-control.service is active\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook does not bypass a present disabled systemd unit", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(home, { recursive: true });

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      HOME: home,
      TEST_SYSTEMCTL_ACTIVE_STATUS: "3",
      TEST_SYSTEMCTL_CAT_STATUS: "0",
      TEST_SYSTEMCTL_ENABLED_STATUS: "1",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /owner: systemd \(codex-remote-control.service is configured but inactive\)/);
    assert.equal(fs.existsSync(callsLog), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook removes dead pid files from both daemon namespaces when Desktop owns remote-control", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const daemonDir = path.join(codexHome, "app-server-daemon");
    const appDir = path.join(tempRoot, "package", "share", "codex-desktop", "app");
    const pidFiles = ["app-server.pid", "app-server-updater.pid", "daemon.pid", "daemon-updater.pid"]
      .map((name) => path.join(daemonDir, name));

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);
    for (const pidFile of pidFiles) {
      fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999, processStartTime: "fixture" }));
    }

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const pidFile of pidFiles) {
      assert.equal(fs.existsSync(pidFile), false, pidFile);
    }
    assert.match(result.stdout, /Removed stale remote mobile control daemon pid file/);
    assert.match(result.stdout, /owner: desktop \(app-server launches with remote-control enabled\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook preserves live pid files from both daemon namespaces when Desktop owns remote-control", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const daemonDir = path.join(codexHome, "app-server-daemon");
    const appDir = path.join(tempRoot, "package", "share", "codex-desktop", "app");
    const pidFiles = ["app-server.pid", "app-server-updater.pid", "daemon.pid", "daemon-updater.pid"]
      .map((name) => path.join(daemonDir, name));
    const pidRecord = JSON.stringify({ pid: process.pid, processStartTime: "fixture" });

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);
    for (const pidFile of pidFiles) {
      fs.writeFileSync(pidFile, pidRecord);
    }

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const pidFile of pidFiles) {
      assert.equal(fs.readFileSync(pidFile, "utf8"), pidRecord, pidFile);
    }
    assert.doesNotMatch(result.stdout, /Removed stale remote mobile control daemon pid file/);
    assert.match(result.stdout, /owner: desktop \(app-server launches with remote-control enabled\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Writes an extracted app in the official rspack layout: main-process
// `early-bootstrap-*` chunks and lazily loaded webview chunks under
// webview/assets/async, each found by its content rather than its name.
const RSPACK_REMOTE_MOBILE_ASSETS = {
  loadGate: "async/24191.7b05d5cf83.js",
  terminalStatus: "async/24192.0a1b2c3d4e.js",
  managerSignals: "async/24193.1a2b3c4d5e.js",
  visibility: "async/435221.eac941d988.js",
  visibilityCopy: "async/446738.83dee6513b.js",
  settings: "async/14625.95f35fcee5.js",
  mobileSetup: "async/996150.d04d0c8dc8.js",
  bridge: "async/855047.05049c3449.js",
  activeStatus: "async/86296.cc31aba811.js",
};
const RSPACK_REMOTE_MOBILE_MAIN = {
  deviceKey: "early-bootstrap-45-628adb74a9c47df1.js",
  appServer: "early-bootstrap-824-1f55dca514436ade.js",
  featureSync: "early-bootstrap-339-305d03d30317c879.js",
};

function writeRspackRemoteMobileApp(tempApp, overrides = {}) {
  const buildDir = path.join(tempApp, ".vite", "build");
  const assetsDir = path.join(tempApp, "webview", "assets");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
  fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));
  const main = {
    deviceKey: syntheticMainBundle() + syntheticAutoConnectServiceBundle() + syntheticRecoverableErrorPredicateBundle(),
    appServer: syntheticCurrentLocalAppServerLaunchChunk(),
    featureSync: syntheticAppMainFeatureSyncBundle(),
    ...overrides.main,
  };
  for (const [key, name] of Object.entries(RSPACK_REMOTE_MOBILE_MAIN)) {
    fs.writeFileSync(path.join(buildDir, name), main[key]);
  }
  const assets = {
    loadGate: syntheticRemoteConnectionVisibilityBundle(),
    terminalStatus: syntheticRemoteTerminalStatusBundle(),
    managerSignals: syntheticAppServerManagerStatusBundle() + syntheticCurrentStatusWaitBundle() +
      syntheticCurrentReasoningSummaryTurnStartBundle() + syntheticCurrentConversationHydrationBundle(),
    visibility: syntheticCurrentUsePluginVisibilityBundle(),
    visibilityCopy: syntheticCurrentUsePluginVisibilityBundle().replace("slingshotEnabled:t}){return t&&", "slingshotEnabled:n}){return n&&"),
    settings: syntheticCurrentRevokeSetupResetBundle() + syntheticRemoteConnectionsSettingsCopyBundle() +
      syntheticOutboundTabGateBundle() + syntheticCurrentSettingsRefreshBundle(),
    mobileSetup: syntheticMobileSetupDialogCopyBundle() + syntheticMobileSetupDialogComputerUseBundle(),
    bridge: syntheticCurrentAppMainEnablementBridgeBundle(),
    activeStatus: syntheticAppMainActiveStatusBundle(),
    ...overrides.assets,
  };
  for (const [key, name] of Object.entries(RSPACK_REMOTE_MOBILE_ASSETS)) {
    fs.writeFileSync(path.join(assetsDir, name), assets[key]);
  }
  fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");
  return { buildDir, assetsDir };
}

test("remote mobile control feature exposes opt-in main-bundle and webview patches", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    const expected = [
      ["linux-remote-control-device-key", "main-bundle"],
      ["linux-remote-control-client-revocation-recovery", "main-bundle"],
      ["linux-remote-mobile-app-server-remote-control", "extracted-app:post-webview"],
      ["linux-remote-control-load-gate", "webview-asset"],
      ["linux-remote-control-feature-sync", "main-bundle"],
      ["linux-remote-control-visibility", "webview-asset"],
      ["linux-remote-control-copy", "webview-asset"],
      ["linux-remote-control-settings-ux", "webview-asset"],
      ["linux-remote-control-client-revoke-setup-reset", "webview-asset"],
      ["linux-remote-connections-refresh", "webview-asset"],
      ["linux-remote-mobile-reasoning-summary-none", "webview-asset"],
      ["linux-remote-mobile-conversation-hydration", "webview-asset"],
      ["linux-remote-terminal-status-recovery", "webview-asset"],
      ["linux-remote-control-status-read-guard", "webview-asset"],
      ["linux-remote-control-status-wait", "webview-asset"],
      ["linux-remote-control-enable-for-host-params", "webview-asset"],
      ["linux-remote-control-enablement-bridge", "webview-asset"],
      ["linux-remote-control-auto-connect-contract", "extracted-app:post-webview"],
      ["linux-remote-mobile-active-status", "webview-asset"],
    ];
    assert.deepEqual(
      descriptors.map((descriptor) => [descriptor.id, descriptor.phase]),
      expected.map(([id, phase]) => [`feature:remote-mobile-control:${id}`, phase]),
    );

    // rspack chunk names identify nothing: webview descriptors select chunks
    // by stable strings, and those strings occur in the current fixtures.
    const fixtures = {
      "linux-remote-control-load-gate": syntheticRemoteConnectionVisibilityBundle(),
      "linux-remote-control-visibility": syntheticCurrentUsePluginVisibilityBundle(),
      "linux-remote-control-copy": syntheticMobileSetupDialogCopyBundle(),
      "linux-remote-control-settings-ux": syntheticOutboundTabGateBundle() + syntheticCurrentSettingsRefreshBundle(),
      "linux-remote-control-client-revoke-setup-reset": syntheticCurrentRevokeSetupResetBundle(),
      "linux-remote-connections-refresh": syntheticCurrentSettingsRefreshBundle(),
      "linux-remote-mobile-reasoning-summary-none": syntheticCurrentReasoningSummaryTurnStartBundle(),
      "linux-remote-mobile-conversation-hydration": syntheticCurrentConversationHydrationBundle(),
      "linux-remote-terminal-status-recovery": syntheticRemoteTerminalStatusBundle(),
      "linux-remote-control-status-read-guard": syntheticAppServerManagerStatusBundle(),
      "linux-remote-control-status-wait": syntheticCurrentStatusWaitBundle(),
      "linux-remote-control-enable-for-host-params": syntheticCurrentAppMainEnablementBridgeBundle(),
      "linux-remote-control-enablement-bridge": syntheticAppMainEnablementBridgeBundle(),
      "linux-remote-mobile-active-status": syntheticAppMainActiveStatusBundle(),
    };
    for (const descriptor of descriptors.filter((candidate) => candidate.phase === "webview-asset")) {
      const id = descriptor.id.replace("feature:remote-mobile-control:", "");
      assert.equal(descriptor.pattern, undefined, id);
      assert.equal(descriptor.assetPattern, undefined, id);
      assert.ok(descriptor.assetNeedles.length > 0, id);
      const fixture = fixtures[id];
      assert.ok(fixture, id);
      assert.ok(descriptor.assetNeedles.every((needle) => fixture.includes(needle)), id);
      if (descriptor.assetMatch != null) {
        assert.equal(descriptor.assetMatch(fixture, "async/1.fixture.js", {}), true, id);
        assert.equal(descriptor.assetMatch("function unrelated(){}", "async/2.fixture.js", {}), false, id);
      }
    }
    const byId = (id) => descriptors.find((descriptor) => descriptor.id === `feature:remote-mobile-control:${id}`);
    // Modules duplicated across chunks are patched in every copy.
    for (const id of ["linux-remote-control-visibility", "linux-remote-control-enable-for-host-params", "linux-remote-control-copy"]) {
      assert.equal(byId(id).assetMatch, undefined, id);
    }
    const hydration = byId("linux-remote-mobile-conversation-hydration");
    const hydrationOwner = syntheticCurrentConversationHydrationBundle();
    assert.equal(hydration.assetMatch(applyLinuxRemoteMobileConversationHydrationPatch(hydrationOwner)), true);
    assert.equal(hydration.assetMatch(hydrationOwner + hydrationOwner), false);
    const loadGate = byId("linux-remote-control-load-gate");
    const loadGateOwner = syntheticRemoteConnectionVisibilityBundle();
    assert.equal(loadGate.assetMatch(applyLinuxRemoteControlLoadGatePatch(loadGateOwner)), true);
    assert.equal(loadGate.assetMatch(loadGateOwner + loadGateOwner), false);
    const revoke = byId("linux-remote-control-client-revoke-setup-reset");
    const revokeOwner = syntheticCurrentRevokeSetupResetBundle();
    assert.equal(revoke.assetMatch(applyLinuxRemoteControlClientRevokeSetupResetPatch(revokeOwner)), true);
  });
});

test("Linux remote-mobile hydration buffers local turn and item notifications in order", async () => {
  const source = syntheticCurrentConversationHydrationBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileConversationHydration/u);
  assert.equal(applyLinuxRemoteMobileConversationHydrationPatch(patched), patched);

  const context = { module: { exports: null } };
  vm.runInNewContext(`${patched};module.exports=HydrationLifecycle;`, context);
  const HydrationLifecycle = context.module.exports;
  const conversations = new Map();
  const hydrateCalls = new Map();
  const pendingHydrations = new Map();
  const replayed = [];
  const replayedMetadata = [];
  const threadStore = {
    conversations,
    hydrateActiveThread(threadId) {
      hydrateCalls.set(threadId, (hydrateCalls.get(threadId) ?? 0) + 1);
      return new Promise((resolve) => pendingHydrations.set(threadId, () => {
        conversations.set(threadId, { items: [] });
        resolve(true);
      }));
    },
    isConversationSuppressed: () => false,
  };
  const manager = {
    isCloudHost: false,
    getHostId: () => "local",
    logger: { debug() {} },
    getConversationOrThrow: (threadId) => conversations.get(threadId),
    onNotification(method, params, automationCapability, shouldIgnore, receivedAtMs) {
      replayed.push(method);
      replayedMetadata.push({ automationCapability, shouldIgnore, receivedAtMs });
      if (method !== "item/started" && method !== "item/completed") return;
      const conversation = conversations.get(params.threadId);
      const existing = conversation.items.findIndex((item) => item.id === params.item.id);
      const item = { ...params.item, completed: method === "item/completed" };
      if (existing === -1) conversation.items.push(item);
      else conversation.items[existing] = item;
    },
  };
  const lifecycle = new HydrationLifecycle(manager, { threadStore }, (callback) => {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  });
  const threadId = "thread-local-ordered";
  const notifications = [
    { method: "turn/started", params: { threadId, turn: { id: "turn-1" } } },
    { method: "item/started", params: { threadId, turnId: "turn-1", item: { id: "item-1" } } },
    { method: "item/completed", params: { threadId, turnId: "turn-1", item: { id: "item-1" } } },
    { method: "turn/completed", params: { threadId, turn: { id: "turn-1" } } },
  ];

  for (const [index, notification] of notifications.entries()) {
    assert.equal(lifecycle.bufferNotification({
      notification, automationCapability: "allowed", receivedAtMs: index + 100,
    }, undefined), true);
  }
  assert.equal(hydrateCalls.get(threadId), 1);
  assert.deepEqual(replayed, []);

  pendingHydrations.get(threadId)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replayed, notifications.map(({ method }) => method));
  assert.deepEqual(replayedMetadata, notifications.map((_notification, index) => ({
    automationCapability: "allowed", shouldIgnore: undefined, receivedAtMs: index + 100,
  })));
  assert.deepEqual(conversations.get(threadId).items, [{ id: "item-1", completed: true }]);

  const completedOnlyThreadId = "thread-local-completed-only";
  assert.equal(lifecycle.bufferNotification({
    notification: {
      method: "item/completed",
      params: {
        threadId: completedOnlyThreadId,
        turnId: "turn-2",
        item: { id: "item-without-start" },
      },
    },
  }, undefined), true);
  assert.equal(hydrateCalls.get(completedOnlyThreadId), 1);
  pendingHydrations.get(completedOnlyThreadId)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(conversations.get(completedOnlyThreadId).items, [
    { id: "item-without-start", completed: true },
  ]);
});

test("Linux remote-mobile hydration leaves durable discovery notification scope unchanged", () => {
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(
    syntheticCurrentConversationHydrationBundle(),
  );
  const context = { module: { exports: null } };
  vm.runInNewContext(`${patched};module.exports=HydrationLifecycle;`, context);
  const HydrationLifecycle = context.module.exports;
  const hydration = new HydrationLifecycle({
    isCloudHost: true,
    getHostId: () => "durable",
    logger: { debug() {} },
  }, {
    threadStore: {
      conversations: new Map(),
      hydrateActiveThread: () => new Promise(() => {}),
      isConversationSuppressed: () => false,
    },
  }, () => () => {});

  assert.equal(hydration.bufferNotification({
    notification: { method: "item/completed", params: { threadId: "thread-durable" } },
  }, undefined), false);
  assert.equal(hydration.bufferNotification({
    notification: { method: "turn/started", params: { threadId: "thread-durable" } },
  }, undefined), true);
});

test("Linux remote-mobile hydration rejects missing, duplicate, and partial lifecycle drift", () => {
  const source = syntheticCurrentConversationHydrationBundle();
  const drifted = [
    source.replace("this.context.threadStore.hydrateActiveThread(", "this.context.threadStore.loadThread("),
    source + source,
    source.replace(
      ":!(!this.manager.isCloudHost",
      ":!(/*codexLinuxRemoteMobileConversationHydration*/!this.manager.isCloudHost",
    ),
  ];

  for (const candidate of drifted) {
    const { result, warnings } = captureWarnings(() =>
      applyLinuxRemoteMobileConversationHydrationPatch(candidate)
    );
    assert.equal(result, candidate);
    assert.match(warnings.join("\n"), /unique complete conversation-hydration lifecycle/u);
  }
});

test("hydration preserves request replay and discards notifications when their owner disappears", async () => {
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(syntheticCurrentConversationHydrationBundle());
  const context = { module: { exports: null } };
  vm.runInNewContext(`${patched};module.exports=HydrationLifecycle;`, context);
  const conversations = new Map();
  const replayed = [];
  let resolveHydration;
  const lifecycle = new context.module.exports({
    isCloudHost: false,
    getHostId: () => "local",
    getConversationOrThrow: (id) => conversations.get(id),
    logger: { debug() {} },
    onRequest: (request) => replayed.push(request.method),
    onNotification: (method) => replayed.push(method),
  }, { threadStore: {
    conversations,
    isConversationSuppressed: () => false,
    hydrateActiveThread: () => new Promise((resolve) => { resolveHydration = resolve; }),
  } }, () => () => {});
  const delivery = { notification: { method: "turn/started", params: { threadId: "thread" } } };
  assert.equal(lifecycle.bufferNotification(delivery), true);
  assert.equal(lifecycle.bufferRequest({ method: "item/tool/call", params: { threadId: "thread", status: "pending" } }, {}, {}), true);
  conversations.set("thread", {});
  resolveHydration(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replayed, ["turn/started", "item/tool/call"]);

  conversations.clear();
  replayed.length = 0;
  let ignored = false;
  assert.equal(lifecycle.bufferNotification(delivery, () => ignored), true);
  ignored = true;
  resolveHydration(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replayed, []);
  assert.equal(lifecycle.pending.size, 0);
  assert.equal(lifecycle.buffer.buffers.size, 0);

  assert.equal(lifecycle.bufferNotification(delivery), true);
  lifecycle.clear();
  resolveHydration(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replayed, []);
  assert.equal(lifecycle.buffer.buffers.size, 0);
});

test("hydration cannot discover Remote SSH, outbound, suppressed, or already loaded conversations", () => {
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(syntheticCurrentConversationHydrationBundle());
  const context = { module: { exports: null } };
  vm.runInNewContext(`${patched};module.exports=HydrationLifecycle;`, context);
  for (const [hostId, loaded, suppressed, method] of [
    ["remote-ssh:dev", false, false, "turn/started"],
    ["remote-control:env", false, false, "item/completed"],
    ["local", true, false, "turn/started"],
    ["local", false, true, "turn/started"],
    ["local", false, false, "thread/name/updated"],
  ]) {
    const lifecycle = new context.module.exports({
      isCloudHost: hostId === "durable",
      getHostId: () => hostId,
    }, { threadStore: {
      conversations: loaded ? new Map([["thread", {}]]) : new Map(),
      isConversationSuppressed: () => suppressed,
      hydrateActiveThread() { assert.fail("must not hydrate this host/conversation"); },
    } }, () => () => {});
    assert.equal(lifecycle.bufferNotification({ notification: { method, params: { threadId: "thread" } } }), false);
    assert.equal(lifecycle.pending.size, 0);
  }
});

test("Linux remote-control feature patch updates the device-key provider", () => {
  const source = syntheticMainBundle();
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /function codexLinuxRemoteControlDeviceKeyAddon\(\)/);
  assert.match(patched, /function codexLinuxRemoteControlDeviceKeyClient\(e\)\{let t=new e\(null\),n=codexLinuxRemoteControlDeviceKeyAddon\(\);return t\.getAddon=\(\)=>n,t\}class wVBase\{/);
  assert.match(patched, /remoteControlDeviceKeyClient=process\.platform===`linux`\?codexLinuxRemoteControlDeviceKeyClient\(wV\):new wV\(\(0,tY\.b\)\(\{resourcesPath:null\}\)\),this\.executionHostRegistry/);
  // Upstream keeps serializing and validating payloads before the addon signs.
  assert.match(patched, /signBytes\(e,t\)\{return this\.getAddon\(\)\.signDeviceKey\(e,t\)\}/);
  assert.match(patched, /return\{\.\.\.await this\.signBytes\(e,n\),signedPayloadBase64:n\.toString\("base64"\)\}/);
  assert.equal(applyLinuxRemoteControlDeviceKeyPatch(patched), patched);
  assert.doesNotThrow(() => new Function(patched));
});

test("Linux remote-control device-key patch handles current minified aliases", () => {
  const source = syntheticCurrentMainBundle().replace(
    "let efn=",
    "class precedingCurrentClass{}let efn=",
  );
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient\(efs\):new efs\(null\)/);
  assert.doesNotThrow(() => new Function(patched));
  const warnings = captureWarns(() => applyLinuxRemoteControlDeviceKeyPatch(patched));
  assert.equal(warnings.value, patched);
  assert.deepEqual(warnings.warnings, []);
});

test("Linux remote-control device-key patch rejects incomplete current state", () => {
  for (const marker of ["codexLinuxRemoteControlDeviceKeyClient", "codexLinuxRemoteControlDeviceKeyAddon"]) {
    const source = `function ${marker}(){}${syntheticCurrentMainBundle()}`;
    const warnings = captureWarns(() => applyLinuxRemoteControlDeviceKeyPatch(source));

    assert.equal(warnings.value, source);
    assert.match(warnings.warnings.join("\n"), /incomplete Linux remote-control device-key patch/u);
  }
});

test("Linux remote-control device-key patch rejects ambiguous and unrelated anchors byte-identically", () => {
  const source = syntheticMainBundle();
  const providerStart = source.indexOf("class wVBase{");
  const providerEnd = source.indexOf("function NV(");
  const providerAnchor = source.slice(providerStart, providerEnd);
  const construction =
    "this.remoteControlDeviceKeyClient=new wV((0,tY.b)({resourcesPath:null})),this.executionHostRegistry";
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);
  const injectedProviderStart = patched.indexOf("const codexLinuxRemoteControlPath=");
  const injectedClientStart = patched.indexOf("function codexLinuxRemoteControlDeviceKeyClient");
  const partialPatched = patched.slice(0, injectedProviderStart) + patched.slice(injectedClientStart);
  const variants = {
    "duplicate provider anchor": source.slice(0, providerEnd) + providerAnchor + source.slice(providerEnd),
    "duplicate construction anchor": `${source}function Other(){${construction}={}}`,
    "provider bypasses its addon": source.replace(
      "deleteDeviceKey(e){return this.getAddon().deleteDeviceKey(e)}",
      "deleteDeviceKey(e){return nativeDelete(e)}",
    ),
    "provider loads another native module": source.replace(
      '"remote-control-device-key.node"',
      '"other-device-key.node"',
    ),
    "provider returns another signed payload": source.replace(
      'signedPayloadBase64:n.toString("base64")',
      'signedPayloadBase64:t.toString("base64")',
    ),
    "provider without the canonical sign domain": source.replace(
      '"codex-device-key-sign-payload/v1"',
      '"other-sign-payload/v1"',
    ),
    "provider in expression position": source.replace("};class wVBase{", "},X=class wVBase{"),
    "provider signs without the base addon route": source.replace(
      "signBytes(e,t){return this.getAddon().signDeviceKey(e,t)}",
      "signBytes(e,t){return nativeSign(e,t)}",
    ),
    "mixed current and patched construction": `${patched}function Other(){${construction}={}}`,
    "partial patched state": partialPatched,
  };

  for (const [name, drifted] of Object.entries(variants)) {
    assert.notEqual(drifted, source, name);
    const result = captureWarns(() => applyLinuxRemoteControlDeviceKeyPatch(drifted));
    assert.equal(result.value, drifted, name);
    assert.equal(result.warnings.length, 1, name);
  }
});

test("Linux remote-control device-key patch warns on unrelated main-process chunks", () => {
  const result = captureWarns(() => applyLinuxRemoteControlDeviceKeyPatch('exports.ids=[87],exports.modules={1(e){"use strict"}};'));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Could not find remote-control device-key bundle needles/);
});

test("Linux remote-control device-key provider does not capture a function-local child-process alias", () => {
  const source = `function injectedFeature(){let __codexChild=require(\`node:child_process\`);return __codexChild}${syntheticMainBundle()}`;
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.match(patched, /codexLinuxRemoteControlChildProcess\.spawn\(/);
  assert.doesNotMatch(patched, /__codexChild\.spawn\(/);
});

test("Linux remote-control device-key provider does not capture a function-local path alias", () => {
  const source = `function injectedFeature(){let n=require("node:path");return n}${syntheticMainBundle()}`;
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.match(patched, /codexLinuxRemoteControlPath\.isAbsolute\(/);
  assert.doesNotMatch(patched, /n\.isAbsolute\(codexLinuxRemoteControlConfigRoot\)/);
});

test("Linux remote-control device-key provider avoids upstream minified alias collisions", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-collision-"));
  try {
    const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticCryptoAliasCollisionMainBundle());
    assert.match(patched, /\(0,codexLinuxRemoteControlCrypto\.generateKeyPairSync\)\(`/);
    assert.match(patched, /codexLinuxRemoteControlKeyRecord/);
    assert.doesNotMatch(patched, /let c=\{algorithm:`ecdsa_p256_sha256`/);

    const context = {
      Buffer,
      clearTimeout,
      Date,
      Error,
      JSON,
      Promise,
      console,
      __filename: path.join(configHome, "early-bootstrap-916-2f6483d5bfd826f1.js"),
      module: { exports: {} },
      process: {
        env: { XDG_CONFIG_HOME: configHome },
        pid: process.pid,
        platform: "linux",
      },
      require,
      setTimeout,
    };

    vm.runInNewContext(`${patched};module.exports=new Owner().remoteControlDeviceKeyClient;`, context);
    const created = await context.module.exports.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");
    assert.match(created.keyId, /^[0-9a-f-]{36}$/u);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux remote-control client revocation triggers local cleanup and re-enrollment", async () => {
  const source = syntheticRecoverableErrorPredicateBundle();
  const patched = applyLinuxRemoteControlClientRevocationRecoveryPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /"Remote control request failed \(403\): Remote-control client key material missing"===p\.message\|\|"Remote-control client key material missing"===p\.message\)\)\)throw t/);
  const warnings = captureWarns(() => applyLinuxRemoteControlClientRevocationRecoveryPatch(patched));
  assert.equal(warnings.value, patched);
  assert.deepEqual(warnings.warnings, []);

  const context = {};
  vm.runInNewContext(`${patched};this.Bd=Bd;`, context);
  const ContextError = vm.runInNewContext("Error", context);
  for (const message of [
    "Remote-control client has been revoked",
    "Remote-control client key material missing",
    "Remote control request failed (403): Remote-control client key material missing",
  ]) {
    assert.equal(await context.Bd(() => { throw new ContextError(message); }), "recovered", message);
  }
  await assert.rejects(
    () => context.Bd(() => { throw new ContextError("Remote control request failed (500): boom"); }),
    /500/,
  );
});

test("Linux remote-control client recovery adds a missing revoked-client check", () => {
  const source = syntheticRecoverableErrorPredicateBundle().replace(
    '"Remote-control client has been revoked"===p.message||',
    "",
  );
  const patched = applyLinuxRemoteControlClientRevocationRecoveryPatch(source);

  assert.match(patched, /\|\|"Remote-control client key material missing"===p\.message\|\|"Remote-control client has been revoked"===p\.message\)\)\)throw t/);
});

test("Linux remote-control client recovery warns instead of reporting unrelated chunks as applied", () => {
  const source = syntheticRecoverableErrorPredicateBundle();
  for (const drifted of [
    'exports.ids=[87],exports.modules={1(e){"use strict"}};',
    source.replace('"Remote control request failed (403): Remote-control client key material missing"===p.message', '"x"===p.message'),
    `${source}${source}`,
  ]) {
    const result = captureWarns(() => applyLinuxRemoteControlClientRevocationRecoveryPatch(drifted));
    assert.equal(result.value, drifted);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /recoverable error predicate/);
  }
});

test("Linux remote mobile app-server launch keeps Desktop as the native Remote Control owner", () => {
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(
    syntheticCurrentLocalAppServerLaunchBundle(),
  );
  const context = {
    JSON,
    module: { exports: {} },
    process: { env: {}, platform: "linux" },
  };

  vm.runInNewContext(`${patched};module.exports=uB;`, context);

  assert.deepEqual(Array.from(context.module.exports()), [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--remote-control",
    "--analytics-default-enabled",
  ]);
  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(patched), patched);
  assert.equal(hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(patched), true);
});

test("Linux remote mobile app-server launch proxies Desktop RPCs to the declarative owner", () => {
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(
    syntheticCurrentLocalAppServerLaunchBundle(),
  );
  const context = {
    JSON,
    module: { exports: {} },
    process: {
      env: {
        CODEX_REMOTE_CONTROL_APP_SERVER_MODE: "proxy",
        CODEX_REMOTE_CONTROL_APP_SERVER_PROXY_SOCKET:
          "%h/.codex/app-server-control/app-server-control.sock",
        HOME: "/home/tester",
      },
      platform: "linux",
    },
  };

  vm.runInNewContext(`${patched};module.exports=uB;`, context);

  assert.deepEqual(Array.from(context.module.exports()), [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "proxy",
    "--sock",
    "/home/tester/.codex/app-server-control/app-server-control.sock",
  ]);
});

test("Linux remote mobile app-server launch preserves current configured-base argument order", () => {
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(
    syntheticCurrentLocalAppServerLaunchBundle(),
  );
  const context = {
    JSON,
    module: { exports: {} },
    process: {
      env: { CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://example.test" },
      platform: "linux",
    },
  };

  vm.runInNewContext(`${patched};module.exports=uB;`, context);

  assert.deepEqual(Array.from(context.module.exports()), [
    "app-server",
    "-c",
    "features.code_mode_host=true",
    "-c",
    'chatgpt_base_url="https://example.test"',
    "--remote-control",
    "--analytics-default-enabled",
  ]);
});

test("Linux startup config check never runs app-server with --remote-control", () => {
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(
    syntheticStartupCommandAppServerLaunchBundle(),
  );
  const run = (env, startupCommand) => {
    const context = {
      JSON,
      module: { exports: {} },
      process: { env, platform: "linux" },
    };
    vm.runInNewContext(`${patched};module.exports=bc;`, context);
    return Array.from(context.module.exports({ startupCommand }).args);
  };
  const startupCommand = { args: ["--print-startup-config"] };

  assert.deepEqual(run({}, startupCommand), [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--analytics-default-enabled",
    "--print-startup-config",
  ]);
  assert.deepEqual(
    run({ CODEX_REMOTE_CONTROL_APP_SERVER_MODE: "proxy", HOME: "/home/tester" }, startupCommand),
    ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "--print-startup-config"],
  );
  // The long-running Desktop app-server keeps owning Remote Control.
  assert.deepEqual(run({}, undefined), [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--remote-control",
    "--analytics-default-enabled",
  ]);
  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(patched), patched);
});

test("Linux startup config guard upgrades a bundle patched before the guard existed", () => {
  const source = syntheticStartupCommandAppServerLaunchBundle();
  const launchOnly = applyLinuxRemoteMobileAppServerRemoteControlPatch(source).replace(
    /codexLinuxStartupCommandAppServerArgs\(([\w$]+)\.args,([\w$]+)\.startupCommand\),/gu,
    "$1.args,",
  ).replace(/function codexLinuxStartupCommandAppServerArgs\(e,t\)\{.*?\}(?=function |let )/u, "");
  const upgraded = applyLinuxRemoteMobileAppServerRemoteControlPatch(launchOnly);

  assert.match(upgraded, /\.\.\.codexLinuxStartupCommandAppServerArgs\(r\.args,e\.startupCommand\)/);
  assert.equal(upgraded.match(/function codexLinuxStartupCommandAppServerArgs/gu).length, 1);
});

test("Linux remote mobile app-server launch rejects an incomplete local patch marker", () => {
  const source = "globalThis.codexLinuxRemoteMobileLocalAppServerArgs=true;";

  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(source), source);
  assert.equal(hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(source), false);
});

test("Linux remote mobile app-server launch does not treat the legacy WSL path as the Desktop transport", () => {
  const source = syntheticLegacyWslAppServerLaunchBundle();

  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(source), source);
});

test("Linux remote mobile extracted-app patch modifies only the local Desktop transport", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-local-transport-"));
  try {
    const buildDir = path.join(tempApp, ".vite", "build");
    const wslFile = path.join(buildDir, "early-bootstrap-339-20e50e14cac1f3bf.js");
    const localFile = path.join(buildDir, "early-bootstrap-824-3c24dda6dba622ec.js");
    const unrelatedFile = path.join(buildDir, "worker.js");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(wslFile, syntheticLegacyWslAppServerLaunchBundle());
    fs.writeFileSync(localFile, syntheticCurrentLocalAppServerLaunchChunk());
    // Only main-process chunks are launch candidates.
    fs.writeFileSync(unrelatedFile, syntheticCurrentLocalAppServerLaunchBundle());

    const descriptor = remoteMobilePatchDescriptors.find(
      ({ id }) => id === "linux-remote-mobile-app-server-remote-control",
    );
    const result = descriptor.apply(tempApp);

    assert.deepEqual(result, { matched: 1, changed: 1 });
    assert.equal(fs.readFileSync(wslFile, "utf8"), syntheticLegacyWslAppServerLaunchBundle());
    assert.equal(fs.readFileSync(unrelatedFile, "utf8"), syntheticCurrentLocalAppServerLaunchBundle());
    const patchedChunk = fs.readFileSync(localFile, "utf8");
    assert.match(patchedChunk, /^function codexLinuxRemoteMobileLocalAppServerArgs\(e,t\)\{.*\}exports\.ids=\[824\]/u);
    assert.deepEqual(descriptor.apply(tempApp), { matched: 1, changed: 0 });

    // The helper declared at the top of the chunk resolves from module factories.
    const chunk = { exports: {} };
    vm.runInNewContext(patchedChunk, {
      JSON,
      exports: chunk.exports,
      process: { env: {}, platform: "linux" },
    });
    const moduleExports = {};
    chunk.exports.modules[10824]({}, moduleExports, { d: (target, getters) => {
      for (const [name, getter] of Object.entries(getters)) Object.defineProperty(target, name, { get: getter });
    } });
    assert.deepEqual(Array.from(moduleExports.uB()), [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--remote-control",
      "--analytics-default-enabled",
    ]);
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("Linux remote mobile extracted-app patch rejects WSL-only and partial local matches", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-partial-transport-"));
  try {
    const buildDir = path.join(tempApp, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "early-bootstrap-339-20e50e14cac1f3bf.js"), syntheticLegacyWslAppServerLaunchBundle());
    fs.writeFileSync(path.join(buildDir, "early-bootstrap-824-3c24dda6dba622ec.js"), "globalThis.codexLinuxRemoteMobileLocalAppServerArgs=true;");

    const descriptor = remoteMobilePatchDescriptors.find(
      ({ id }) => id === "linux-remote-mobile-app-server-remote-control",
    );
    const result = descriptor.apply(tempApp);

    assert.deepEqual(result, {
      matched: 0,
      changed: 0,
      reason: "no local Desktop app-server base args found",
    });
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("retired reasoning-summary resolver is rejected byte-identically", () => {
  const source = syntheticReasoningSummaryTurnStartBundle();
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteMobileReasoningSummaryPatch(source),
  );
  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("turn-start resolver")));
});

test("reasoning-summary resolver without model configuration is rejected byte-identically", () => {
  const source = syntheticCurrentReasoningSummaryTurnStartBundle().replace(
    "ye=null==C?null:C.model_reasoning_summary??ye,",
    "",
  );
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteMobileReasoningSummaryPatch(source),
  );
  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("turn-start resolver")));
});

test("reasoning-summary caller without the current Aeon override is rejected byte-identically", () => {
  const source = syntheticCurrentReasoningSummaryTurnStartBundle().replace(
    '||b?"detailed"',
    '?"detailed"',
  );
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteMobileReasoningSummaryPatch(source));
  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("incomplete reasoning-summary")));
});

test("duplicate reasoning-summary owner pairs are rejected byte-identically", () => {
  const owner = syntheticCurrentReasoningSummaryTurnStartBundle();
  const source = owner + owner.replaceAll("HWt", "AWt").replaceAll("QWt", "BWt");
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteMobileReasoningSummaryPatch(source),
  );
  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("ambiguous reasoning-summary")));
});

test("mixed pristine and patched reasoning-summary owner pairs are rejected byte-identically", () => {
  const owner = syntheticCurrentReasoningSummaryTurnStartBundle();
  const patchedOwner = applyLinuxRemoteMobileReasoningSummaryPatch(owner);
  const pristineOwner = owner.replaceAll("HWt", "AWt").replaceAll("QWt", "BWt");
  const source = patchedOwner + pristineOwner;
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteMobileReasoningSummaryPatch(source),
  );
  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("ambiguous reasoning-summary")));
});

test("partial reasoning-summary owner pairs are rejected byte-identically", () => {
  const patched = applyLinuxRemoteMobileReasoningSummaryPatch(
    syntheticCurrentReasoningSummaryTurnStartBundle(),
  );
  const partialSources = [
    patched.replace(
      'codexLinuxRemoteMobileHost:(0,gh.ZJ)(e.getHostId())&&"durable"===a.mode,',
      "",
    ),
    patched.replace(
      '/*codexLinuxRemoteMobileReasoningSummaryNone*/navigator.userAgent.includes("Linux")&&o.codexLinuxRemoteMobileHost&&void 0===s.summary&&(ye="none");',
      "",
    ),
  ];
  for (const source of partialSources) {
    const { result, warnings } = captureWarnings(() =>
      applyLinuxRemoteMobileReasoningSummaryPatch(source),
    );
    assert.equal(result, source);
    assert.ok(warnings.some((warning) => warning.includes("incomplete reasoning-summary")));
  }
});

test("a reasoning-summary resolver with ambiguous callers is rejected byte-identically", () => {
  const owner = syntheticCurrentReasoningSummaryTurnStartBundle();
  const callerStart = owner.indexOf("async function QWt");
  const duplicateCaller = owner.slice(callerStart).replace("QWt", "RWt");
  const source = owner + duplicateCaller;
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteMobileReasoningSummaryPatch(source),
  );
  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("ambiguous or incomplete")));
});

test("current reasoning-summary owner keeps durable mobile summaries off and preserves explicit summaries", async () => {
  const source = syntheticCurrentReasoningSummaryTurnStartBundle();
  const patched = applyLinuxRemoteMobileReasoningSummaryPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileReasoningSummaryNone/);
  assert.match(patched, /codexLinuxRemoteMobileHost:\(0,gh\.ZJ\)\(e\.getHostId\(\)\)&&"durable"===a\.mode/);
  assert.equal(applyLinuxRemoteMobileReasoningSummaryPatch(patched), patched);

  const context = {
    gh: { ZJ: (hostId) => hostId === "local" },
    logger: { info() {} },
    module: { exports: {} },
    navigator: { userAgent: "X11; Linux x86_64" },
  };
  vm.runInNewContext(`${patched};module.exports=QWt;`, context);
  const startTurn = context.module.exports;
  const args = (request, mode) => [null, { request }, null, null, {
    configRequirements: { model_reasoning_summary: "model" },
    initialParams: { summary: "auto" },
    latestThreadSettings: { summary: "auto" },
    mode,
  }];
  const manager = (hostId) => ({
    getDefaultFeatureOverride: () => true,
    getHostId: () => hostId,
  });
  assert.equal((await startTurn(manager("local"), ...args({}, "durable"))).summary, "none");
  assert.equal((await startTurn(manager("local"), ...args({}, "default"))).summary, "model");
  assert.equal((await startTurn(manager("remote-ssh:dev"), ...args({}, "durable"))).summary, "model");
  assert.equal(
    (await startTurn(manager("local"), ...args({ summary: "concise" }, "durable"))).summary,
    "concise",
  );
});

test("Aeon summaries keep their upstream override outside local Linux durable turns", async () => {
  const source = syntheticCurrentReasoningSummaryTurnStartBundle();
  const patched = applyLinuxRemoteMobileReasoningSummaryPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyLinuxRemoteMobileReasoningSummaryPatch(patched), patched);
  const context = {
    gh: { ZJ: (hostId) => hostId === "local" },
    logger: { info() {} },
    module: { exports: {} },
    navigator: { userAgent: "Linux" },
  };
  vm.runInNewContext(`${patched};module.exports=QWt;`, context);
  for (const userAgent of ["Linux", "Macintosh"]) {
    context.navigator.userAgent = userAgent;
    for (const host of ["local", "remote-ssh:dev", "durable"]) {
      for (const mode of ["durable", "default"]) {
        for (const aeon of [true, false]) {
          for (const explicit of [undefined, "concise", "none"]) {
            for (const rollout of [true, false]) {
              const result = await context.module.exports(
                { getHostId: () => host, getDefaultFeatureOverride: () => rollout },
                null,
                {
                  request: { summary: explicit },
                  context: { threadStartKind: aeon ? "aeon" : "regular" },
                },
                null, null,
                { mode, configRequirements: {}, initialParams: { summary: "auto" } },
              );
              const localDurable = userAgent === "Linux" && host === "local" && mode === "durable";
              const inherited = aeon || rollout ? "detailed" : "auto";
              const expected = explicit ?? (localDurable ? "none" : inherited);
              assert.equal(
                result.summary,
                expected,
                JSON.stringify({ userAgent, host, mode, aeon, explicit, rollout }),
              );
            }
          }
        }
      }
    }
  }
});

test("Linux remote mobile reasoning-summary patch reports upstream drift", () => {
  const source = "async function yY(){return 1}";
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteMobileReasoningSummaryPatch(source),
  );
  assert.equal(result, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find reasoning-summary turn-start log marker - skipping Linux remote mobile summary patch",
  ]);
});

test("Linux remote-control client revoke resets current setup state after the last client is removed", () => {
  const source = syntheticCurrentRevokeSetupResetBundle();
  const { result: patched, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlClientRevokeSetupResetPatch(source),
  );

  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  assert.match(patched, /GrdY\(e,t,n\)\{function codexLinuxRemoteControlResetMobileSetupAfterRevoke\(e,t,n\)\{/);
  assert.match(patched, /T\.appServices\?\.applicationState\?\.write\("codex-mobile-has-connected-device",!1\)/);
  assert.match(patched, /ej\.setData\(t=>codexLinuxRemoteControlResetMobileSetupAfterRevoke\(t,e,ec\)\)/);
  assert.equal(applyLinuxRemoteControlClientRevokeSetupResetPatch(patched), patched);

  const { handler, query, writes } = loadRevokeSettings(patched, [{ clientId: "desktop_1" }, { clientId: "phone_1" }]);
  handler("phone_1");

  assert.deepEqual(query.data, [{ clientId: "desktop_1" }]);
  assert.deepEqual(writes, [["codex-mobile-has-connected-device", false]]);
  assert.equal(query.invalidated, true);
});

test("Linux remote-control client revoke handles snake-case cached client identities", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const { handler, query, writes } = loadRevokeSettings(patched, [{ client_id: "desktop_1" }, { client_id: "phone_1" }]);
  handler("phone_1");

  assert.deepEqual(query.data, [{ client_id: "desktop_1" }]);
  assert.deepEqual(writes, [["codex-mobile-has-connected-device", false]]);
});

test("Linux remote-control client revoke keeps current setup state while another client remains", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const { handler, query, writes } = loadRevokeSettings(patched, [{ clientId: "desktop_1" }, { clientId: "phone_1" }, { clientId: "tablet_1" }]);
  handler("phone_1");

  assert.deepEqual(query.data, [{ clientId: "desktop_1" }, { clientId: "tablet_1" }]);
  assert.deepEqual(writes, []);
});

test("Linux remote-control client revoke resets current setup when the cache omits the local client", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const { handler, query, writes } = loadRevokeSettings(patched, [{ clientId: "phone_1" }]);
  handler("phone_1");

  assert.deepEqual(query.data, []);
  assert.deepEqual(writes, [["codex-mobile-has-connected-device", false]]);
});

test("Linux remote-control client revoke preserves current setup when the cache is unknown", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const { handler, query, writes } = loadRevokeSettings(patched, undefined);
  handler("phone_1");

  assert.equal(query.data, undefined);
  assert.deepEqual(writes, []);
  assert.equal(query.invalidated, true);
});

test("Linux remote-control client revoke warns when a recognized bundle shape drifts", () => {
  const current = syntheticCurrentRevokeSetupResetBundle();
  const drifted = {
    reordered: current.replace(
      "onRevoked:e=>{ej.setData(t=>t?.filter(t=>t.clientId!==e)),ej.invalidate()}",
      "onRevoked:e=>{ej.invalidate(),ej.setData(t=>t?.filter(t=>t.clientId!==e))}",
    ),
    // The local client id must belong to the component that owns the handler.
    foreignLocalClient: current.replace("x={localRemoteControlClientId:ec},", "").replace(
      "async function np(e){",
      "function other(){let ec=1;return{localRemoteControlClientId:ec}}async function np(e){",
    ),
    // Injected module-scope code may only use the module's own import binding.
    unboundAppServices: current.replace('var T=n("GaA7"),', "var "),
    duplicateHandler: current.replace("return{handler:", "x2={onRevoked:e=>{ej.setData(t=>t?.filter(t=>t.clientId!==e)),ej.invalidate()},onRevokeResult:null};return{handler:"),
  };
  for (const [name, source] of Object.entries(drifted)) {
    assert.notEqual(source, current, name);
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlClientRevokeSetupResetPatch(source));
    assert.equal(result, source, name);
    assert.ok(warnings.some((warning) => warning.includes("revoke success handler")), name);
  }
});

test("Linux remote-control load gate enables remote-control environment loading", () => {
  const source = syntheticRemoteConnectionVisibilityBundle();
  const patched = applyLinuxRemoteControlLoadGatePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /function p\(\)\{return codexLinuxRemoteControlLoadGateEnabled\(\)\|\|\(0,o\.Zj\)\("1042620455"\)\}function codexLinuxRemoteControlLoadGateEnabled\(\)\{/);
  assert.equal(applyLinuxRemoteControlLoadGatePatch(patched), patched);
  const gates = [];
  for (const userAgent of ["X11; Linux x86_64", "Macintosh"]) {
    const { mC } = loadRspackModule(patched, "PIwo", { statsig: { Zj: (gate) => { gates.push(gate); return false; } } }, { navigator: { userAgent } });
    assert.equal(mC(), userAgent.includes("Linux"));
  }
  assert.deepEqual(gates, ["1042620455"]);
});

test("Linux remote-control load gate rejects non-current and ambiguous shapes", () => {
  const current = syntheticRemoteConnectionVisibilityBundle();
  for (const source of [
    "function f(){return c(`1042620455`)}",
    current.replace('function p(){return(0,o.Zj)("1042620455")}', 'function p(){return(0,o.Zj)("1042620455")}function q(){return(0,o.Zj)("1042620455")}'),
  ]) {
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlLoadGatePatch(source));
    assert.equal(result, source);
    assert.match(warnings.join("\n"), /unique remote-control loader rollout gate/);
  }
});

test("Linux remote-control feature sync enables remote_control for the local app server only", async () => {
  const source = syntheticAppMainFeatureSyncBundle();
  const patched = applyLinuxRemoteControlFeatureSyncPatch(source);

  assert.notEqual(patched, source);
  assert.ok(patched.startsWith('"use strict";function codexLinuxRemoteControlFeatureSyncEnabled(e,t){'));
  assert.match(patched, /\{enablement:codexLinuxRemoteControlFeatureSyncEnabled\(i,e\.connection\.hostId\)\},s\)/);
  assert.equal(applyLinuxRemoteControlFeatureSyncPatch(patched), patched);
  new vm.Script(patched);

  for (const platform of ["linux", "darwin"]) {
    const exports = {};
    vm.runInNewContext(patched, { exports, process: { platform } });
    const factoryExports = {};
    exports.modules[57240]({}, factoryExports, () => ({}));
    const sync = new factoryExports.Sync({
      readExecutionAssignments: async () => ({ defaultEnableFeatures: {}, values: { experimentalFeatureGates: { curatedRemoteMarketplace: true } } }),
    });
    const sent = [];
    for (const hostId of ["local", "remote-ssh-discovered:devpod", "durable"]) {
      await sync.sendEnablement({
        connection: { hostId, sendAppServerRequest: async (method, params) => { sent.push({ hostId, method, params }); return { enablement: {} }; } },
      }, 1);
    }
    assert.deepEqual(sent.map(({ hostId, params }) => [hostId, params.enablement.remote_control, params.enablement.remote_plugin]), [
      ["local", platform === "linux" ? true : undefined, true],
      ["remote-ssh-discovered:devpod", undefined, true],
      ["durable", undefined, true],
    ]);
  }
});

test("Linux remote-control feature sync warns on unrelated, ambiguous, or partial chunks", () => {
  const source = syntheticAppMainFeatureSyncBundle();
  const patched = applyLinuxRemoteControlFeatureSyncPatch(source);
  const call = 'e.connection.sendAppServerRequest("experimentalFeature/enablement/set",{enablement:i},s)';
  for (const drifted of [
    'exports.ids=[87],exports.modules={1(e){"use strict"}};',
    source.replace(call, `${call},${call}`),
    patched.replace('"use strict";function codexLinuxRemoteControlFeatureSyncEnabled(e,t){return"linux"===process.platform&&"local"===t?{...e,remote_control:!0}:e}', '"use strict";'),
  ]) {
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlFeatureSyncPatch(drifted));
    assert.equal(result, drifted);
    assert.match(warnings.join("\n"), /experimental feature enablement sync/);
  }
});

test("Linux remote-control visibility patch rejects an owner without the current access gate", () => {
  const source = syntheticCurrentVisibilityBundle();
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlVisibilityPatch(source)
  );

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("unique remote-control visibility gate")));
});

test("Linux remote-control visibility patch handles current use-plugin gate shape", () => {
  const source = syntheticCurrentUsePluginVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return\(codexLinuxRemoteControlOnLinux\|\|t\)&&\(codexLinuxRemoteControlOnLinux\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
  // A fresh local name cannot collide with minified parameters such as `n`.
  const renamed = applyLinuxRemoteControlVisibilityPatch(source.replace("slingshotEnabled:t}){return t&&", "slingshotEnabled:n}){return n&&"));
  assert.doesNotThrow(() => new Function(renamed.replace(/export\{[^}]*\};?$/, "")));
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux mobile setup copy does not refer to Mac-only Computer Use", () => {
  const source = syntheticMobileSetupDialogComputerUseBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /apps on your Mac/);
  assert.match(patched, /apps on this Linux desktop/);
  assert.match(patched, /codexLinuxRemoteControlCopy/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux remote-control settings copy does not refer to this Mac", () => {
  const source = syntheticRemoteConnectionsSettingsCopyBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /defaultMessage:"[^"]*Mac/);
  assert.match(patched, /Control this Linux desktop/);
  assert.match(patched, /Devices that can control this Linux desktop/);
  assert.match(patched, /Devices you can control from this Linux desktop/);
  assert.match(patched, /SSH connections from this Linux desktop/);
  assert.match(patched, /Keep this Linux desktop awake/);
  assert.match(patched, /connected to ChatGPT on this Linux desktop/);
  assert.doesNotMatch(patched, /connected to ChatGPT on a Mac/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux mobile setup dialog copy does not refer to Mac-only setup", () => {
  const source = syntheticMobileSetupDialogCopyBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /defaultMessage:"[^"]*Mac/);
  assert.match(patched, /Use your Linux apps while locked/);
  assert.match(patched, /Control Linux apps from your phone/);
  assert.match(patched, /apps on this Linux desktop/);
  assert.match(patched, /Connect your phone to this Linux desktop/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux remote-control settings UX preserves the retired upstream SSH installer", () => {
  const retiredInstallAction =
    "function ro({action:e,disabled:t,hostId:n,onAuthenticate:r,onReconnect:i,onRestart:a}){if(e==null)return null;switch(e.kind){case`install-codex`:return null;case`login`:return{label:e.label,onClick:()=>r(n)};case`restart`:return{label:e.label,onClick:a};case`reconnect`:return{label:e.label,onClick:i};case`settings`:return null}}";
  const source = syntheticRemoteConnectionsSettingsCopyBundle() + retiredInstallAction;
  const patched = applyLinuxRemoteControlSettingsUxPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /case`install-codex`:return null/);
  assert.doesNotMatch(patched, /codexLinuxRemoteControlSshInstall/);
  assert.match(patched, /Control this Linux desktop/);
  assert.match(patched, /Devices that can control this Linux desktop/);
  assert.match(patched, /Keep this Linux desktop awake/);
  assert.match(patched, /SSH connections from this Linux desktop/);
  assert.doesNotMatch(patched, /Control this Mac/);
  assert.doesNotMatch(patched, /this Mac/);
  assert.equal(applyLinuxRemoteControlSettingsUxPatch(patched), patched);
});

test("Linux remote-control settings UX patch bypasses outbound tab hide gate on Linux", () => {
  const source = [
    "function $n(e,t){return e.displayName.localeCompare(t.displayName)}",
    'function Uo(){let l=(0,G.Zj)("782640499"),u=(0,G.Zj)(on),z=Ge(),B=!l,Se=null==f,Ce=null==p,Ke=z&&!0,qe=B&&(z||!1),Je=z&&!0;return qe}',
  ].join("");
  const patched = applyLinuxRemoteControlSettingsUxPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlOutboundTabGate/);
  assert.match(patched, /B=\/\*codexLinuxRemoteControlOutboundTabGate\*\/\(typeof navigator!=`undefined`&&navigator\.userAgent\.includes\(`Linux`\)\|\|!l\)/);
  assert.doesNotMatch(patched, /B=!l/);
  assert.equal(applyLinuxRemoteControlSettingsUxPatch(patched), patched);

  const context = {
    Ge: () => true,
    G: { Zj: () => true },
    f: [],
    navigator: { userAgent: "Linux" },
    on: "gate",
    p: [],
  };
  vm.runInNewContext(`${patched};globalThis.__visible=Uo();`, context);
  assert.equal(context.__visible, true);
});

test("Linux remote-control settings UX patch warns when outbound tab gate consumer drifts", () => {
  const source = 'function Uo(){let l=(0,G.Zj)("782640499"),u=(0,G.Zj)(on),z=Ge(),B=l,Se=null==f;return B&&z}';
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlSettingsUxPatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("outbound tab gate consumer")));
});

test("Linux remote-connections refresh patch shortens polling and refreshes on resume signals", () => {
  const source = syntheticCurrentSettingsRefreshBundle();
  const patched = applyLinuxRemoteConnectionsRefreshPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /r=window\.setInterval\(\(\)=>\{n\(\)\},5e3\);/);
  assert.doesNotMatch(patched, /15e3/);
  assert.match(patched, /codexLinuxRemoteConnectionsRefreshNow/);
  assert.match(patched, /codexLinuxRemoteConnectionsRefreshTimer=null/);
  assert.match(patched, /codexLinuxRemoteConnectionsRefreshLast=0/);
  assert.match(patched, /e-codexLinuxRemoteConnectionsRefreshLast<1e3/);
  assert.match(patched, /document\.addEventListener\(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`focus`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`online`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`resume`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.clearTimeout\(codexLinuxRemoteConnectionsRefreshTimer\)/);
  assert.match(patched, /document\.removeEventListener\(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.removeEventListener\(`resume`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.equal(applyLinuxRemoteConnectionsRefreshPatch(patched), patched);
});

test("Linux remote-connections refresh patch warns when upstream refresh needles drift", () => {
  for (const source of [
    'const marker={id:"settings.remoteConnections.refresh"};window.setInterval(()=>marker,15e3);',
    syntheticCurrentSettingsRefreshBundle().replace("15e3", "Yn"),
    syntheticCurrentSettingsRefreshBundle().repeat(2),
  ]) {
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteConnectionsRefreshPatch(source));
    assert.equal(result, source);
    assert.ok(warnings.some((warning) => warning.includes("unique remote-connections auto-refresh effect")));
  }
});

function remoteStatusHarness({ userAgent = "X11; Linux x86_64", skip = false } = {}) {
  const source = syntheticAppServerManagerStatusBundle();
  const patched = applyLinuxRemoteControlStatusReadGuardPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyLinuxRemoteControlStatusReadGuardPatch(patched), patched);
  const errors = [];
  const context = {
    module: { exports: {} },
    navigator: { userAgent },
    ou: () => skip,
    AbortController,
    Symbol,
  };
  vm.runInNewContext(`${patched};o.v.error=(...args)=>errors.push(args);module.exports=p;`,
    { ...context, errors });
  const SO = context.module.exports;
  const values = new Map();
  const store = {
    get: (_atom, hostId) => values.get(hostId) ?? null,
    set: (_atom, hostId, value) => values.set(hostId, value),
  };
  function connect(hostId, isCurrent) {
    let resolveRead, rejectRead, resolveSubscription, listener;
    const calls = [];
    const broken = [];
    let disposals = 0;
    const subscription = new Promise((resolve) => { resolveSubscription = resolve; });
    subscription[Symbol.dispose] = () => { disposals += 1; };
    subscription.onRpcBroken = (callback) => broken.push(callback);
    const cleanup = SO(store, hostId, {
      subscribe(options) {
        assert.equal(options.key.hostId, hostId);
        assert.equal(options.methods, "remoteControl/status/changed");
        listener = options.listener;
        return subscription;
      },
      sendRequest(method, params) {
        calls.push({ method, params });
        return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
      },
    }, isCurrent);
    return {
      calls, cleanup, broken,
      notify: (params) => listener({ params }),
      resolveRead: (status) => resolveRead(status),
      rejectRead: (error) => rejectRead(error),
      resolveSubscription: () => resolveSubscription({
        [Symbol.dispose]() { disposals += 1; },
        onRpcBroken: (callback) => broken.push(callback),
      }),
      disposals: () => disposals,
    };
  }
  return { connect, values, errors };
}

test("Linux remote-control status guard skips remote reads and retains disposable notifications", async () => {
  const { connect, values } = remoteStatusHarness();
  for (const hostId of ["remote-ssh-discovered:dev", "remote-control:env_test"]) {
    const connection = connect(hostId);
    assert.deepEqual(connection.calls, []);
    assert.deepEqual(JSON.parse(JSON.stringify(values.get(hostId))), {
      status: "disabled", available: false, accessRequired: false,
    });
    connection.notify({ status: "connected" });
    assert.equal(values.get(hostId).status, "connected");
    connection.resolveSubscription();
    await new Promise((resolve) => setImmediate(resolve));
    connection.cleanup();
    connection.cleanup();
    assert.equal(connection.disposals(), 2);
    connection.notify({ status: "disabled" });
    assert.equal(values.get(hostId).status, "connected");
  }
});

test("local status reads preserve RPC parameters and cannot overwrite a newer notification", async () => {
  const { connect, values } = remoteStatusHarness();
  const connection = connect("local");
  assert.deepEqual(connection.calls, [{ method: "remoteControl/status/read", params: undefined }]);
  connection.notify({ status: "connected" });
  connection.resolveRead({ status: "disabled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(values.get("local").status, "connected");
  connection.cleanup();
});

test("local status reads stop applying responses after disposal, stale ownership, or RPC break", async () => {
  const { connect, values, errors } = remoteStatusHarness();
  const disposed = connect("local");
  disposed.cleanup();
  disposed.resolveRead({ status: "connected" });
  disposed.resolveSubscription();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(values.has("local"), false);
  assert.equal(disposed.disposals(), 2);

  let current = true;
  const stale = connect("local", () => current);
  current = false;
  stale.notify({ status: "connected" });
  stale.resolveRead({ status: "connected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(values.has("local"), false);
  stale.cleanup();

  const broken = connect("local");
  broken.broken[0]();
  broken.rejectRead(new Error("RPC broke"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(values.has("local"), false);
  assert.deepEqual(errors, []);
});

test("status guard preserves local responses and non-Linux remote reads", async () => {
  for (const [userAgent, hostId] of [["Linux", "local"], ["Macintosh", "remote-ssh:test"]]) {
    const { connect, values } = remoteStatusHarness({ userAgent });
    const connection = connect(hostId);
    assert.equal(connection.calls.length, 1);
    connection.resolveRead({ status: "connected" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(values.get(hostId).status, "connected");
    connection.cleanup();
  }
  const skipped = remoteStatusHarness({ skip: true }).connect("durable");
  assert.deepEqual(skipped.calls, []);
  assert.equal(typeof skipped.cleanup, "function");
});

test("status guard rejects incomplete, duplicate, mixed, and marker-only contracts", () => {
  const source = syntheticAppServerManagerStatusBundle();
  const patched = applyLinuxRemoteControlStatusReadGuardPatch(source);
  const drifted = [
    source.replace("new AbortController", "new Controller"),
    source.replace("p.onRpcBroken(f)", "p.onRpcBroken(other)"),
    source.replace("d()&&h(e,t,n)", "h(e,t,n)"),
    source.replace("let s;if((0,i.C)(t))", "if((0,i.C)(t))"),
    source + source,
    source + patched,
    patched + patched,
    source + "/*codexLinuxRemoteControlShouldReadStatus*/",
    patched.replace("available:!1", "available:!0"),
    patched.replace("remoteControl/status/read", "remoteControl/status/replaced"),
    "function codexLinuxRemoteControlShouldReadStatus(){}",
  ];
  for (const candidate of drifted) {
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlStatusReadGuardPatch(candidate));
    assert.equal(result, candidate);
    assert.match(warnings.join("\n"), /unique complete remote-control status subscription/);
  }
});

test("status guard warns instead of reporting an unrelated chunk as patched", () => {
  const source = "export function unrelatedStatus(){return null}";
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlStatusReadGuardPatch(source));
  assert.equal(result, source);
  assert.match(warnings.join("\n"), /unique complete remote-control status subscription/);
});

function loadTerminalStatusModules(patched) {
  const jotai = { i1: (_scope, read) => read };
  const terminal = loadRspackModule(patched, "EU9a", { jotai, state: { pC: "pC", ok: "ok" }, work: { Oz: "Oz" } });
  const isApproval = (requests) => Array.isArray(requests) && requests.some((request) => request.method.endsWith("/requestApproval"));
  const pending = loadRspackModule(patched, "sZJm", {
    jotai, threads: { hF: "hF" }, approvals: { PZ: isApproval, w_: (type) => type === "approval" },
  });
  return { terminal, pending };
}

test("Linux remote terminal status recovery treats stale waiting input as idle", () => {
  const source = syntheticRemoteTerminalStatusBundle();
  const patched = applyPatchTwice(applyLinuxRemoteTerminalStatusRecoveryPatch, source);

  assert.match(patched, /codexLinuxRemoteTerminalStatusActive=i\?\.type==="active"/);
  assert.match(patched, /latestTurnHasSystemError:i\?\.latestTurnError!=null,hasUserInputRequest:codexLinuxRemoteHasUserInputRequest\(i\?\.requests\)\}\)/);
  assert.match(patched, /latestTurnHasSystemError:a\?\.latestTurnError!=null,hasUserInputRequest:codexLinuxRemoteHasUserInputRequest\(a\?\.requests\)\}\)/);
  assert.match(patched, /i\.activeFlags\.includes\("waitingOnUserInput"\)&&codexLinuxRemoteHasUserInputRequest\(n\)\?\{autoResolution:null/);
  // Every calling module declares its own helper: modules share no scope.
  for (const moduleId of ["EU9a", "e9KY", "sZJm"]) {
    assert.ok(patched.includes(`${moduleId}(e,t,n){function codexLinuxRemoteHasUserInputRequest(e){`), moduleId);
  }
  assert.doesNotMatch(patched, /i\?\.type==="active"\?"loading":"needs_resume"===r/);

  const { terminal, pending } = loadTerminalStatusModules(patched);
  const status = (overrides) => terminal.sX({
    hasInProgressOwnedWork: false, isResponseInProgress: false, latestTurnHasSystemError: false,
    resumeState: null, threadRuntimeStatus: null, ...overrides,
  });
  const active = (activeFlags) => ({ type: "active", ...(activeFlags ? { activeFlags } : {}) });
  assert.deepEqual({
    stale: status({ threadRuntimeStatus: active([]) }),
    nullStatus: status({}),
    streaming: status({ isResponseInProgress: true, threadRuntimeStatus: active([]) }),
    waitingStale: status({ threadRuntimeStatus: active(["waitingOnUserInput"]), hasUserInputRequest: false }),
    waitingWithRequest: status({ threadRuntimeStatus: active(["waitingOnUserInput"]), hasUserInputRequest: true }),
    waitingWithoutWiredRequest: status({ threadRuntimeStatus: active(["waitingOnUserInput"]) }),
    unknownShape: status({ threadRuntimeStatus: active() }),
    ownedWork: status({ hasInProgressOwnedWork: true, threadRuntimeStatus: active([]) }),
    systemError: status({ threadRuntimeStatus: { type: "systemError" } }),
    turnError: status({ latestTurnHasSystemError: true, threadRuntimeStatus: { type: "idle" } }),
    needsResume: status({ resumeState: "needs_resume", threadRuntimeStatus: { type: "idle" } }),
  }, {
    stale: "idle",
    nullStatus: "idle",
    streaming: "loading",
    waitingStale: "idle",
    waitingWithRequest: "loading",
    waitingWithoutWiredRequest: "loading",
    unknownShape: "loading",
    ownedWork: "loading",
    systemError: "error",
    turnError: "error",
    needsResume: "idle",
  });

  // The list-state caller wires the pending requests of the same thread.
  const listState = (requests) => ({
    requests,
    summary: { threadRuntimeStatus: active(["waitingOnUserInput"]) },
    isResponseInProgress: false,
    latestTurnError: null,
  });
  const atom = (state) => terminal.h({ conversationId: "thread", hostId: "local" }, {
    get: (key) => key === "ok" ? state : key === "Oz" ? false : null,
  });
  assert.equal(atom(listState([])), "idle");
  assert.equal(atom(listState([{ method: "item/tool/requestUserInput" }])), "loading");

  const resolve = (state) => {
    const result = pending.Z({ conversationId: "thread", hostId: "local" }, { get: () => state });
    return result == null ? null : result.kind === "input" ? "response" : result.kind;
  };
  const needsResume = (requests, activeFlags) => ({
    requests, resumeState: "needs_resume", threadRuntimeStatus: active(activeFlags), pendingRequest: null,
  });
  assert.deepEqual({
    pendingStale: resolve(needsResume([], ["waitingOnUserInput"])),
    pendingWithRequest: resolve(needsResume([{ method: "item/tool/requestUserInput" }], ["waitingOnUserInput"])),
    pendingApproval: resolve(needsResume([{ method: "item/commandExecution/requestApproval" }], ["waitingOnApproval"])),
    pendingLive: resolve({ requests: [], resumeState: "resumed", threadRuntimeStatus: active([]), pendingRequest: { kind: "userInput" } }),
  }, {
    pendingStale: null,
    pendingWithRequest: "response",
    pendingApproval: "approval",
    pendingLive: "response",
  });
});

test("Linux remote terminal status recovery rejects partial current-bundle drift", () => {
  const source = syntheticRemoteTerminalStatusBundle();
  const patched = applyLinuxRemoteTerminalStatusRecoveryPatch(source);
  const driftedSources = [
    source.replace("threadRuntimeStatus:i}){return", "threadRuntimeStatus:i,extra:o}){return"),
    source.replace('i?.type==="active"&&i.activeFlags.includes("waitingOnUserInput")?{autoResolution', 'i?.type==="active"?{autoResolution'),
    source.replace("latestTurnHasSystemError:a?.latestTurnError!=null})", "latestTurnHasSystemError:!1})"),
    source.replace("return m({hasInProgressOwnedWork:", "return m({hasInProgressOwnedWork:!1,isResponseInProgress:null,latestTurnHasSystemError:i?.latestTurnError!=null})||m({hasInProgressOwnedWork:"),
    patched.replace(",hasUserInputRequest:codexLinuxRemoteHasUserInputRequest(a?.requests)", ""),
    source + "function codexLinuxRemoteTerminalStatusActive(){}",
  ];

  for (const driftedSource of driftedSources) {
    assert.notEqual(driftedSource, source);
    const { result, warnings } = captureWarnings(() =>
      applyLinuxRemoteTerminalStatusRecoveryPatch(driftedSource),
    );
    assert.equal(result, driftedSource);
    assert.ok(
      warnings.some((warning) =>
        warning.includes("skipping Linux remote terminal status recovery patch"),
      ),
    );
  }
});

test("Linux remote terminal status recovery warns on unrelated chunks", () => {
  const source = "const remoteMobileConversationChunk={threadRuntimeStatus:null};";
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteTerminalStatusRecoveryPatch(source),
  );

  assert.equal(result, source);
  assert.match(warnings.join("\n"), /skipping Linux remote terminal status recovery patch/);
});

test("Linux remote terminal status recovery escapes current minified function aliases", () => {
  const source = syntheticRemoteTerminalStatusBundle()
    .replace("return m({", "return $m({")
    .replace("function m({", "function $m({")
    .replace("sX:()=>m}", "sX:()=>$m}");
  const patched = applyLinuxRemoteTerminalStatusRecoveryPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /function \$m\(\{hasInProgressOwnedWork:e,[^}]*hasUserInputRequest:codexLinuxRemoteHasUserInputRequestPending=!0\}\)/);
  assert.equal(loadTerminalStatusModules(patched).terminal.sX({ threadRuntimeStatus: { type: "active", activeFlags: [] } }), "idle");
});

test("Linux remote-control status wait supports the current rspack bundle", () => {
  const source = syntheticCurrentStatusWaitBundle();
  const patched = applyLinuxRemoteControlStatusWaitPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /\},typeof navigator!=`undefined`&&navigator\.userAgent\.includes\(`Linux`\)\?3e4:5e3\/\*codexLinuxRemoteControlStatusWaitMs\*\/\)/);
  assert.equal(applyLinuxRemoteControlStatusWaitPatch(patched), patched);
});

test("Linux remote-control status wait rejects duplicate, missing, and partial timeouts", () => {
  const source = syntheticCurrentStatusWaitBundle();
  for (const drifted of [
    source + source,
    source.replace("},5e3);a=e.watch", "},F5t);a=e.watch"),
    source.replace('methods:"remoteControl/status/changed"', 'methods:"remoteControl/status/other"'),
    source + "/*codexLinuxRemoteControlStatusWaitMs*/",
  ]) {
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlStatusWaitPatch(drifted));
    assert.equal(result, drifted);
    assert.match(warnings.join("\n"), /unique remote-control status wait timeout/);
  }
});

test("Linux remote-control settings UX patch does not require retired SSH installer anchors", () => {
  const source = syntheticRemoteConnectionsSettingsCopyBundle() + syntheticOutboundTabGateBundle();
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlSettingsUxPatch(source));

  assert.notEqual(result, source);
  assert.match(result, /Control this Linux desktop/);
  assert.deepEqual(warnings, []);
});

test("remote mobile feature patch report records feature metadata", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-report-"));
    try {
      // The bridge chunk mentions the bridge but no longer holds its owner.
      writeRspackRemoteMobileApp(tempApp, {
        assets: {
          bridge: 'function OF(){let e=B.remoteConnections;return e.setRemoteControlEnabled({enabled:true}).catch(e=>{D.warning("[remote-connections/gate-bridge] sync_failed",{safe:{},sensitive:{error:e}})})}',
        },
      });

      const report = createPatchReport();
      withFeatureRootEnv(root, () => patchExtractedApp(tempApp, { report }));

      assert.deepEqual(report.enabledFeatures, ["remote-mobile-control"]);
      const settingsPatch = report.patches.find(
        (patch) => patch.name === "feature:remote-mobile-control:linux-remote-control-settings-ux",
      );
      assert.equal(settingsPatch.sourceKind, "feature");
      assert.equal(settingsPatch.featureId, "remote-mobile-control");
      assert.equal(settingsPatch.status, "applied");
      assert.equal(settingsPatch.warnings, undefined);

      const enablementBridgePatch = report.patches.find(
        (patch) =>
          patch.name ===
          "feature:remote-mobile-control:linux-remote-control-enablement-bridge",
      );
      assert.equal(enablementBridgePatch.status, "skipped-optional");
      assert.ok(
        enablementBridgePatch.warnings.some((warning) =>
          warning.includes("app main bundle"),
        ),
      );
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});

test("Linux remote mobile active-status patch treats active thread status as active without stream role", () => {
  const source = syntheticAppMainActiveStatusBundle();
  const patched = applyLinuxRemoteMobileActiveStatusPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileActiveStatus/);
  assert.equal(applyLinuxRemoteMobileActiveStatusPatch(patched), patched);

  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=ei;`, context);
  const labels = { "Subscribed: active": "active", "Subscribed: follower": "follower", "Needs resume": "needs-resume", "Read-only snapshot": "read-only", "Subscribed: idle": "inactive" };
  const status = (args) => labels[context.module.exports(args)];

  assert.equal(
    status({
      latestTurnStatus: "completed",
      resumeState: "needs_resume",
      streamRole: null,
      threadRuntimeStatus: { type: "active" },
    }),
    "active",
  );
  assert.equal(
    status({
      latestTurnStatus: "completed",
      resumeState: "needs_resume",
      streamRole: null,
      threadRuntimeStatus: { type: "notLoaded" },
    }),
    "needs-resume",
  );
  assert.equal(
    status({
      latestTurnStatus: "completed",
      resumeState: "resumed",
      streamRole: { role: "follower" },
      threadRuntimeStatus: { type: "active" },
    }),
    "follower",
  );
});

function runEnablementBridge(patched, { userAgent = "X11; Linux x86_64", checkGate = () => false, isLoading = false, result } = {}) {
  const calls = [];
  const context = {
    navigator: { userAgent },
    c: { c: () => [] },
    ed: { cn: () => ({ checkGate, isLoading }) },
    u: { useEffect(callback) { callback(); } },
    y: { v: { warning() {} } },
    na: { appServices: { remoteConnections: { setRemoteControlEnabled(params) {
      calls.push({ method: "setRemoteControlEnabled", params });
      return Promise.resolve(result);
    } } } },
  };
  vm.runInNewContext(`${patched};p4();`, context);
  return calls;
}

test("Linux remote-control enablement bridge loads remote-control clients on Linux", async () => {
  const source = syntheticAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /let l=t\|\|\/\*codexLinuxRemoteControlEnablementBridge\*\/typeof navigator!=`undefined`&&navigator\.userAgent\.includes\(`Linux`\);return /);
  assert.equal(applyLinuxRemoteControlEnablementBridgePatch(patched), patched);

  const calls = runEnablementBridge(patched);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "setRemoteControlEnabled");
  assert.equal(calls[0].params.enabled, true);
  assert.equal(calls[0].params.oneToOnePairingInAppEnabled, false);
});

test("Linux remote-control enablement bridge accepts the current service contract only", () => {
  const current = syntheticAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(current);
  assert.notEqual(patched, current);
  assert.match(patched, /\.setRemoteControlEnabled\(/u);
  assert.equal(applyLinuxRemoteControlEnablementBridgePatch(patched), patched);

  for (const retired of [
    current.replace(".setRemoteControlEnabled(", ".setRemoteConnectionsEnabled("),
    current.replace('t=s("1042620455")||o', 't=s("1042620455")'),
    current.replace("[remote-connections/gate-bridge]", "[remote-connections/other]"),
  ]) {
    const { result, warnings } = captureWarnings(() =>
      applyLinuxRemoteControlEnablementBridgePatch(retired),
    );
    assert.equal(result, retired);
    assert.ok(warnings.some((warning) => warning.includes("enablement bridge owner")));
  }
});

test("Linux remote-control enablement bridge rejects anchors outside its owner", () => {
  const source = [
    'var DF="[remote-connections/gate-bridge]";',
    syntheticAppMainEnablementBridgeBundle().replace('"[remote-connections/gate-bridge] sync_failed"', "DF"),
  ].join("");
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlEnablementBridgePatch(source),
  );

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("owners=0")));
});

test("Linux remote-control enablement bridge rejects duplicate semantic owners byte-identically", () => {
  const source = syntheticAppMainEnablementBridgeBundle().repeat(2);
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlEnablementBridgePatch(source),
  );

  assert.equal(matchesLinuxRemoteControlEnablementBridgeContract(source), false);
  assert.equal(result, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /uniquely resolve current remote-control enablement bridge owner/);
  assert.match(warnings[0], /owners=2/);
});

test("Linux remote-control enablement bridge reports current anchor drift instead of false success", () => {
  const source =
    "function OF(){return B.remoteConnections.setRemoteControlEnabled({enabled:true})}";
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlEnablementBridgePatch(source),
  );

  assert.equal(result, source);
  assert.ok(
    warnings.some((warning) =>
      warning.includes("current remote-control enablement bridge owner"),
    ),
  );
});

test("Linux remote-control enablement bridge preserves the current second gate off Linux", () => {
  const patched = applyLinuxRemoteControlEnablementBridgePatch(
    syntheticAppMainEnablementBridgeBundle(),
  );
  const checkedGates = [];
  const calls = runEnablementBridge(patched, {
    userAgent: "Macintosh",
    checkGate(gate) {
      checkedGates.push(gate);
      return gate === "2055603567";
    },
  });

  assert.deepEqual(checkedGates, ["2055603567", "1042620455"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.enabled, true);
  assert.equal(calls[0].params.oneToOnePairingInAppEnabled, true);
});

test("Linux remote-control enablement bridge waits for current gates to load", () => {
  const patched = applyLinuxRemoteControlEnablementBridgePatch(
    syntheticAppMainEnablementBridgeBundle(),
  );
  assert.equal(runEnablementBridge(patched, { isLoading: true }).length, 0);
});

test("Linux remote-control host toggle omits params for the current request module", async () => {
  const source = syntheticCurrentAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnableForHostParamsPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /"remoteControl\/disable",void 0\/\*codexLinuxRemoteControlEnableForHostParams\*\/\)/);
  assert.doesNotMatch(patched, /"remoteControl\/disable",null/);
  assert.equal(applyLinuxRemoteControlEnableForHostParamsPatch(patched), patched);
  // The bridge and the toggle are separate contracts.
  assert.equal(applyLinuxRemoteControlEnablementBridgePatch(patched).includes("codexLinuxRemoteControlEnableForHostParams"), true);

  const calls = [];
  const statuses = [];
  const context = {
    i: { AP: "status", Lt: (_store, _host, status) => statuses.push(status) },
    a: { V: () => ({
      sendRequest(method, params) {
        calls.push({ method, params });
        return Promise.resolve({ status: "enabled" });
      },
    }) },
    store: { get: () => null },
  };
  await vm.runInNewContext(`${patched};s(store,"local",true);`, context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "remoteControl/enable");
  assert.equal(calls[0].params, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(statuses)), [{ status: "enabled" }]);
});

test("Linux remote-control host toggle params patch warns when its request drifts", () => {
  const current = syntheticCurrentAppMainEnablementBridgeBundle();
  for (const source of [
    'async function s(e,t,n){return(0,a.V)(e,t).sendRequest((n?"remoteControl/enable":"remoteControl/disable"),null)}',
    current + current,
    current + "/*codexLinuxRemoteControlEnableForHostParams*/",
  ]) {
    const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlEnableForHostParamsPatch(source));
    assert.equal(result, source);
    assert.ok(warnings.some((warning) => warning.includes("unique remote-control enable-for-host request")));
  }
});

test("Linux remote-control enablement bridge preserves service-owned auto-connect choices", async () => {
  const source = syntheticAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

  assert.doesNotMatch(patched, /setAutoConnect|set-remote-connection-auto-connect/);

  const calls = runEnablementBridge(patched, { result: { remoteControlConnections: [] } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "setRemoteControlEnabled");
  assert.equal(calls[0].params.enabled, true);
  assert.equal(calls[0].params.oneToOnePairingInAppEnabled, false);
});

test("upstream auto-connect service preserves an explicit settings choice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-auto-connect-contract-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
    const serviceSource = syntheticAutoConnectServiceBundle();
    const callerSource = syntheticAutoConnectSettingsCallerBundle();
    fs.writeFileSync(path.join(buildDir, "early-bootstrap-45-628adb74a9c47df1.js"), serviceSource);
    // The settings page is a lazily loaded rspack chunk.
    fs.writeFileSync(path.join(assetsDir, "async", "14625.95f35fcee5.js"), callerSource);

    assert.deepEqual(validateLinuxRemoteControlAutoConnectContract(root), {
      matched: true,
      changed: false,
    });

    const calls = [];
    const context = {
      T: { appServices: { remoteConnections: null } },
      module: { exports: {} },
    };
    vm.runInNewContext(`${serviceSource};module.exports=ConnectionsService;`, context);
    const service = new context.module.exports({
      setRemoteConnectionAutoConnect(hostId, autoConnect) {
        calls.push({ hostId, autoConnect });
        return Promise.resolve({ hostId, autoConnect });
      },
    });
    context.T.appServices.remoteConnections = service;
    vm.runInNewContext(`${callerSource};this.callAutoConnect=np;`, context);

    await context.callAutoConnect({ hostId: "host-1", autoConnect: false });
    await context.callAutoConnect({ hostId: "host-1", autoConnect: true });
    assert.deepEqual(calls, [
      { hostId: "host-1", autoConnect: false },
      { hostId: "host-1", autoConnect: true },
    ]);

    fs.appendFileSync(path.join(buildDir, "early-bootstrap-45-628adb74a9c47df1.js"), serviceSource);
    const { result, warnings } = captureWarnings(() =>
      validateLinuxRemoteControlAutoConnectContract(root),
    );
    assert.equal(result.matched, false);
    assert.match(result.reason, /service=2, caller=1/);
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patched Linux device-key provider signs upstream-canonical enrollment and connection payloads", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-store-"));
  try {
    const sharedConfigDirectory = path.join(configHome, "codex-desktop");
    fs.mkdirSync(sharedConfigDirectory, { mode: 0o755 });
    const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticMainBundle());
    const context = {
      Buffer,
      clearTimeout,
      Date,
      Error,
      JSON,
      Promise,
      console,
      __filename: path.join(configHome, "early-bootstrap-916-2f6483d5bfd826f1.js"),
      module: { exports: {} },
      process: {
        env: { XDG_CONFIG_HOME: configHome },
        pid: process.pid,
        platform: "linux",
      },
      require,
      setTimeout,
    };

    vm.runInNewContext(`${patched};module.exports=new Owner().remoteControlDeviceKeyClient;`, context);
    const client = context.module.exports;
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");
    assert.match(created.publicKeySpkiDerBase64, /^[A-Za-z0-9+/]+=*$/);

    const readBack = await client.getDeviceKeyPublic(created.keyId);
    assert.deepEqual(readBack, created);

    const signature = await client.signDeviceKey(created.keyId, validEnrollmentPayload());
    assert.equal(signature.algorithm, "ecdsa_p256_sha256");
    assert.match(signature.signatureDerBase64, /^[A-Za-z0-9+/]+=*$/);
    assert.match(signature.signedPayloadBase64, /^[A-Za-z0-9+/]+=*$/);
    const signedPayload = Buffer.from(signature.signedPayloadBase64, "base64");
    assert.equal(signedPayload.toString("utf8"), JSON.stringify({
      domain: "codex-device-key-sign-payload/v1",
      payload: {
        accountUserId: "user_1",
        audience: "remote_control_client_enrollment",
        challengeExpiresAt: "2026-09-27T12:00:00.000Z",
        challengeId: "challenge_1",
        clientId: "client_1",
        deviceIdentitySha256Base64url: VALID_DEVICE_KEY_DIGEST,
        nonce: VALID_DEVICE_KEY_NONCE,
        targetOrigin: "https://chatgpt.com",
        targetPath: "/backend-api/codex/remote/control/client/enroll/finish",
        type: "remoteControlClientEnrollment",
      },
    }));
    const publicKey = crypto.createPublicKey({
      format: "der",
      key: Buffer.from(created.publicKeySpkiDerBase64, "base64"),
      type: "spki",
    });
    assert.equal(
      crypto.verify(
        "sha256",
        signedPayload,
        publicKey,
        Buffer.from(signature.signatureDerBase64, "base64"),
      ),
      true,
    );

    const connectionSignature = await client.signDeviceKey(created.keyId, validConnectionPayload());
    assert.equal(
      Buffer.from(connectionSignature.signedPayloadBase64, "base64").toString("utf8"),
      JSON.stringify({
        domain: "codex-device-key-sign-payload/v1",
        payload: {
          accountUserId: "user_1",
          audience: "remote_control_client_websocket",
          clientId: "client_1",
          nonce: VALID_DEVICE_KEY_NONCE,
          scopes: ["remote_control_controller_websocket"],
          sessionId: "session_1",
          targetOrigin: "https://chatgpt.com",
          targetPath: "/backend-api/codex/remote/control/connect",
          tokenExpiresAt: "2026-09-27T12:00:00.000Z",
          tokenSha256Base64url: VALID_DEVICE_KEY_DIGEST,
          type: "remoteControlClientConnection",
        },
      }),
    );

    const storeDirectory = path.join(sharedConfigDirectory, "remote-control-device-keys");
    const storePath = path.join(storeDirectory, "remote-control-device-keys-v1.json");
    assert.equal(fs.statSync(sharedConfigDirectory).mode & 0o777, 0o755);
    assert.equal(fs.statSync(storeDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);

    await client.deleteDeviceKey(created.keyId);
    await assert.rejects(() => client.getDeviceKeyPublic(created.keyId), /not found/);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key provider preserves upstream payload validation", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-validation-"));
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");

    await assert.rejects(
      () => client.signDeviceKey(created.keyId, validEnrollmentPayload({ nonce: "short" })),
      /Invalid remote-control device-key nonce/u,
    );
    await assert.rejects(
      () => client.signDeviceKey(created.keyId, validEnrollmentPayload({ audience: "wrong" })),
      /Invalid remote-control device-key enrollment audience/u,
    );
    await assert.rejects(
      () => client.signDeviceKey(created.keyId, validEnrollmentPayload({ deviceIdentitySha256Base64url: "short" })),
      /Invalid remote-control device-key SHA-256 digest/u,
    );
    await assert.rejects(
      () => client.signDeviceKey(created.keyId, validConnectionPayload({ scopes: ["wrong"] })),
      /Invalid remote-control device-key connection scopes/u,
    );
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key provider encrypts protected records and decrypts them for signing", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-safe-storage-"));
  try {
    const storage = createSafeStorage();
    const client = createPatchedDeviceKeyClient(configHome, { electron: { safeStorage: storage.safeStorage } });
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    const { store } = remoteControlKeyStorePaths(configHome);
    const persistedText = fs.readFileSync(store, "utf8");
    const record = JSON.parse(persistedText).keys[created.keyId];

    assert.equal(record.storageBackend, "gnome_libsecret");
    assert.equal(record.detectedBackend, "gnome_libsecret");
    assert.equal(typeof record.privateKeyCiphertextBase64, "string");
    assert.equal(record.privateKeyPkcs8Pem, undefined);
    assert.doesNotMatch(persistedText, /-----BEGIN PRIVATE KEY-----/u);

    const signature = await client.signDeviceKey(created.keyId, validEnrollmentPayload());
    assert.equal(signature.algorithm, "ecdsa_p256_sha256");
    assert.equal(storage.calls.encrypt.length, 1);
    assert.equal(storage.calls.decrypt.length, 1);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key provider falls back for basic_text and unavailable safeStorage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-safe-storage-fallback-"));
  try {
    const basicText = createSafeStorage({ backend: "basic_text" });
    const basicTextClient = createPatchedDeviceKeyClient(path.join(root, "basic-text"), {
      electron: { safeStorage: basicText.safeStorage },
    });
    const basicTextKey = await basicTextClient.createDeviceKey("allow_os_protected_nonextractable");
    const basicTextRecord = JSON.parse(fs.readFileSync(remoteControlKeyStorePaths(path.join(root, "basic-text")).store, "utf8"))
      .keys[basicTextKey.keyId];
    assert.equal(basicTextRecord.storageBackend, "file_0600");
    assert.equal(basicTextRecord.detectedBackend, "basic_text");
    assert.equal(typeof basicTextRecord.privateKeyPkcs8Pem, "string");
    assert.equal(basicText.calls.encrypt.length, 0);

    const unavailableClient = createPatchedDeviceKeyClient(path.join(root, "unavailable"), { electron: {} });
    const unavailableKey = await unavailableClient.createDeviceKey("allow_os_protected_nonextractable");
    const unavailableRecord = JSON.parse(fs.readFileSync(remoteControlKeyStorePaths(path.join(root, "unavailable")).store, "utf8"))
      .keys[unavailableKey.keyId];
    assert.equal(unavailableRecord.storageBackend, "file_0600");
    assert.equal(unavailableRecord.detectedBackend, "unavailable");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux device-key migration retains the legacy PEM when encryption fails", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-safe-storage-migration-failure-"));
  try {
    const fallbackClient = createPatchedDeviceKeyClient(configHome);
    const created = await fallbackClient.createDeviceKey("allow_os_protected_nonextractable");
    const { store } = remoteControlKeyStorePaths(configHome);
    const original = fs.readFileSync(store, "utf8");
    const storage = createSafeStorage({ encryptError: new Error("keychain unavailable") });
    const protectedClient = createPatchedDeviceKeyClient(configHome, { electron: { safeStorage: storage.safeStorage } });

    assert.equal((await protectedClient.getDeviceKeyPublic(created.keyId)).keyId, created.keyId);
    assert.equal(fs.readFileSync(store, "utf8"), original);
    assert.equal(storage.calls.encrypt.length, 1);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key migration serializes with a concurrent key update through flock", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-safe-storage-lock-"));
  try {
    const fallbackClient = createPatchedDeviceKeyClient(configHome);
    const existing = await fallbackClient.createDeviceKey("allow_os_protected_nonextractable");
    const storage = createSafeStorage();
    const lockChildren = [];
    const waitingChildren = [];
    let spawnCalls = 0;
    const childProcess = require("node:child_process");
    const protectedClient = createPatchedDeviceKeyClient(configHome, {
      "node:child_process": {
        ...childProcess,
        spawn() {
          spawnCalls += 1;
          const child = new EventEmitter();
          child.stderr = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stdin = {
            end: () => {
              child.emit("close", 0);
              const next = waitingChildren.shift();
              if (next != null) setImmediate(() => next.stdout.emit("data", Buffer.from("ready\n")));
            },
          };
          child.kill = () => child.emit("close", 1);
          if (lockChildren.length > 0) waitingChildren.push(child);
          lockChildren.push(child);
          return child;
        },
      },
      electron: { safeStorage: storage.safeStorage },
    });

    const migration = protectedClient.getDeviceKeyPublic(existing.keyId);
    const concurrentCreate = protectedClient.createDeviceKey("allow_os_protected_nonextractable");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 2, "migration and concurrent updates must each acquire the file lock");
    lockChildren[0].stdout.emit("data", Buffer.from("ready\n"));
    const [migrated, replacement] = await Promise.all([migration, concurrentCreate]);
    const persisted = JSON.parse(fs.readFileSync(remoteControlKeyStorePaths(configHome).store, "utf8"));
    assert.equal(migrated.keyId, existing.keyId);
    assert.ok(persisted.keys[existing.keyId]);
    assert.ok(persisted.keys[replacement.keyId]);
    assert.equal(persisted.keys[existing.keyId].privateKeyPkcs8Pem, undefined);
    assert.equal(typeof persisted.keys[existing.keyId].privateKeyCiphertextBase64, "string");
    assert.equal(storage.calls.encrypt.length, 2);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key replacement remains committed when directory fsync fails after rename", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-post-rename-"));
  try {
    let failedDirectorySync = false;
    const fsOverride = {
      ...fs,
      fsyncSync(fd) {
        if (!failedDirectorySync && fs.fstatSync(fd).isDirectory()) {
          failedDirectorySync = true;
          throw new Error("simulated directory fsync failure");
        }
        return fs.fsyncSync(fd);
      },
    };
    const client = createPatchedDeviceKeyClient(configHome, { "node:fs": fsOverride });
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    const persisted = JSON.parse(fs.readFileSync(remoteControlKeyStorePaths(configHome).store, "utf8"));

    assert.equal(failedDirectorySync, true);
    assert.ok(persisted.keys[created.keyId]);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key store serializes concurrent updates", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-concurrency-"));
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    const created = await Promise.all(
      Array.from({ length: 8 }, () => client.createDeviceKey("allow_os_protected_nonextractable")),
    );
    const { directory, lock, store } = remoteControlKeyStorePaths(configHome);
    const persisted = JSON.parse(fs.readFileSync(store, "utf8"));

    assert.equal(persisted.version, 2);
    assert.deepEqual(new Set(Object.keys(persisted.keys)), new Set(created.map((key) => key.keyId)));
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store).mode & 0o777, 0o600);
    assert.equal(fs.statSync(lock).mode & 0o777, 0o600);

    const replacementPromise = client.createDeviceKey("allow_os_protected_nonextractable");
    const deletionPromise = client.deleteDeviceKey(created[0].keyId);
    const [replacement] = await Promise.all([replacementPromise, deletionPromise]);
    const updated = JSON.parse(fs.readFileSync(store, "utf8"));
    assert.equal(updated.keys[created[0].keyId], undefined);
    assert.ok(updated.keys[replacement.keyId]);
    assert.equal(Object.keys(updated.keys).length, 8);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key operations wait for lock process stdio to close", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-close-"));
  try {
    const child = new EventEmitter();
    child.stdin = { end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;

    const client = createPatchedDeviceKeyClient(configHome, {
      "node:child_process": {
        spawn() {
          return child;
        },
      },
    });
    let settled = false;
    const creation = client.createDeviceKey("allow_os_protected_nonextractable").then((value) => {
      settled = true;
      return value;
    });

    child.stdout.emit("data", Buffer.from("ready\n"));
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, false, "the lock operation must not resolve before child stdio closes");

    child.emit("close", 0, null);
    await creation;
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key store contends on its validated lock file", { timeout: 10_000 }, async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-lock-"));
  let holder;
  let holderClosed;
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    await client.createDeviceKey("test");
    const { lock } = remoteControlKeyStorePaths(configHome);
    holder = spawn("flock", ["-x", lock, "sh", "-c", "printf 'ready\\n'; sleep 0.25"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    holderClosed = once(holder, "close");
    await new Promise((resolve, reject) => {
      let output = "";
      holder.once("error", reject);
      holder.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("ready\n")) resolve();
      });
    });

    const startedAt = Date.now();
    await client.createDeviceKey("test");
    const [holderExitCode] = await holderClosed;
    assert.ok(Date.now() - startedAt >= 150, "key update must wait for the existing file lock");
    assert.equal(holderExitCode, 0);
  } finally {
    if (holder && holder.exitCode == null && holder.signalCode == null) {
      holder.kill("SIGKILL");
    }
    await holderClosed?.catch(() => {});
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key lock helper resolves flock and sh outside usr bin fallbacks", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-nix-lock-"));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-nix-bin-"));
  try {
    const realFlock = findExecutableOnPath("flock");
    const realShell = findExecutableOnPath("sh");
    assert.ok(realFlock, "flock must be available for the lock helper test");
    assert.ok(realShell, "sh must be available for the lock helper test");

    const fakeFlock = path.join(fakeBin, "flock");
    const fakeShell = path.join(fakeBin, "sh");
    fs.writeFileSync(fakeFlock, `#!${realShell}\nexec ${JSON.stringify(realFlock)} "$@"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(fakeShell, `#!${realShell}\nexec ${JSON.stringify(realShell)} "$@"\n`, {
      mode: 0o755,
    });

    const hiddenFallbacks = new Set(["/usr/bin/flock", "/bin/flock", "/usr/bin/sh", "/bin/sh"]);
    const nativeFs = require("node:fs");
    const fsOverride = {
      ...nativeFs,
      realpathSync(candidate, ...args) {
        if (hiddenFallbacks.has(String(candidate))) {
          const error = new Error("hidden fallback");
          error.code = "ENOENT";
          throw error;
        }
        return nativeFs.realpathSync(candidate, ...args);
      },
      statSync(candidate, ...args) {
        if (hiddenFallbacks.has(String(candidate))) {
          const error = new Error("hidden fallback");
          error.code = "ENOENT";
          throw error;
        }
        return nativeFs.statSync(candidate, ...args);
      },
      accessSync(candidate, ...args) {
        if (hiddenFallbacks.has(String(candidate))) {
          const error = new Error("hidden fallback");
          error.code = "ENOENT";
          throw error;
        }
        return nativeFs.accessSync(candidate, ...args);
      },
    };
    const childProcess = require("node:child_process");
    const spawnCalls = [];
    const client = createPatchedDeviceKeyClient(
      configHome,
      {
        "node:child_process": {
          ...childProcess,
          spawn(command, args, options) {
            spawnCalls.push({ args, command });
            return childProcess.spawn(command, args, options);
          },
        },
        "node:fs": fsOverride,
      },
      { PATH: fakeBin },
    );

    await client.createDeviceKey("allow_os_protected_nonextractable");

    assert.ok(spawnCalls.length >= 1);
    assert.equal(spawnCalls[0].command, fakeFlock);
    assert.equal(spawnCalls[0].args[4], fakeShell);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Linux device-key store migrates the legacy schema on the next write", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-migration-"));
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    const first = await client.createDeviceKey("allow_os_protected_nonextractable");
    const { store } = remoteControlKeyStorePaths(configHome);
    const legacy = JSON.parse(fs.readFileSync(store, "utf8"));
    delete legacy.version;
    fs.writeFileSync(store, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    fs.chmodSync(store, 0o600);

    const second = await client.createDeviceKey("allow_os_protected_nonextractable");
    const migrated = JSON.parse(fs.readFileSync(store, "utf8"));
    assert.equal(migrated.version, 2);
    assert.ok(migrated.keys[first.keyId]);
    assert.ok(migrated.keys[second.keyId]);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key store moves the previous key file into its private directory", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-path-migration-"));
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    const { directory, lock, store } = remoteControlKeyStorePaths(configHome);
    const legacyStore = path.join(configHome, "codex-desktop", "remote-control-device-keys-v1.json");
    fs.rmSync(lock, { force: true });
    fs.renameSync(store, legacyStore);
    fs.rmdirSync(directory);

    const migratedClient = createPatchedDeviceKeyClient(configHome);
    assert.equal((await migratedClient.getDeviceKeyPublic(created.keyId)).keyId, created.keyId);
    assert.equal(fs.existsSync(legacyStore), false);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key store rejects corruption without replacing it", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-corrupt-"));
  try {
    const { directory, store } = remoteControlKeyStorePaths(configHome);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(store, "{truncated", { mode: 0o600 });
    const client = createPatchedDeviceKeyClient(configHome);

    await assert.rejects(
      () => client.createDeviceKey("allow_os_protected_nonextractable"),
      /contains invalid JSON/,
    );
    assert.equal(fs.readFileSync(store, "utf8"), "{truncated");
    assert.deepEqual(
      fs.readdirSync(directory).filter((entry) => entry.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key store does not remove a colliding temporary file", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-temp-"));
  try {
    const { directory, store } = remoteControlKeyStorePaths(configHome);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const collisionPath = `${store}.tmp-collision`;
    fs.writeFileSync(collisionPath, "keep", { mode: 0o600 });
    const crypto = require("node:crypto");
    const randomValues = ["key-id", "collision"];
    const client = createPatchedDeviceKeyClient(configHome, {
      "node:crypto": { ...crypto, randomUUID: () => randomValues.shift() ?? crypto.randomUUID() },
    });

    await assert.rejects(() => client.createDeviceKey("test"), /EEXIST|file already exists/);
    assert.equal(fs.readFileSync(collisionPath, "utf8"), "keep");
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux device-key store rejects unsafe filesystem objects", { timeout: 2_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-fs-"));
  try {
    const directorySymlinkHome = path.join(root, "directory-symlink");
    const directoryTarget = path.join(root, "directory-target");
    fs.mkdirSync(directorySymlinkHome, { mode: 0o700 });
    fs.mkdirSync(directoryTarget, { mode: 0o700 });
    fs.symlinkSync(directoryTarget, path.join(directorySymlinkHome, "codex-desktop"));
    await assert.rejects(
      () => createPatchedDeviceKeyClient(directorySymlinkHome).createDeviceKey("test"),
      /config path must be a regular directory/,
    );

    const storeSymlinkHome = path.join(root, "store-symlink");
    const storeSymlinkPaths = remoteControlKeyStorePaths(storeSymlinkHome);
    fs.mkdirSync(storeSymlinkPaths.directory, { recursive: true, mode: 0o700 });
    const target = path.join(root, "sensitive-target");
    fs.writeFileSync(target, "unchanged", { mode: 0o600 });
    fs.symlinkSync(target, storeSymlinkPaths.store);
    await assert.rejects(
      () => createPatchedDeviceKeyClient(storeSymlinkHome).createDeviceKey("test"),
      /must be a regular file/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "unchanged");

    const fifoHome = path.join(root, "fifo");
    const fifoPaths = remoteControlKeyStorePaths(fifoHome);
    fs.mkdirSync(fifoPaths.directory, { recursive: true, mode: 0o700 });
    const mkfifo = spawnSync("mkfifo", [fifoPaths.store], { encoding: "utf8" });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    fs.chmodSync(fifoPaths.store, 0o600);
    await assert.rejects(
      () => createPatchedDeviceKeyClient(fifoHome).getDeviceKeyPublic("missing"),
      /must be a regular file/,
    );

    const lockSymlinkHome = path.join(root, "lock-symlink");
    const lockClient = createPatchedDeviceKeyClient(lockSymlinkHome);
    await lockClient.createDeviceKey("test");
    const lockPaths = remoteControlKeyStorePaths(lockSymlinkHome);
    fs.rmSync(lockPaths.lock);
    fs.symlinkSync(target, lockPaths.lock);
    await assert.rejects(
      () => lockClient.createDeviceKey("test"),
      /ELOOP|too many symbolic links|must be a regular file/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux device-key store enforces paths, permissions, and size bounds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-bounds-"));
  try {
    await assert.rejects(
      () => createPatchedDeviceKeyClient("relative-config").createDeviceKey("test"),
      /config root must be absolute/,
    );

    const directoryModeHome = path.join(root, "directory-mode");
    const directoryModePaths = remoteControlKeyStorePaths(directoryModeHome);
    fs.mkdirSync(directoryModePaths.directory, { recursive: true, mode: 0o755 });
    await assert.rejects(
      () => createPatchedDeviceKeyClient(directoryModeHome).createDeviceKey("test"),
      /directory permissions must be 0700/,
    );

    const storeModeHome = path.join(root, "store-mode");
    const storeModeClient = createPatchedDeviceKeyClient(storeModeHome);
    const storeModeKey = await storeModeClient.createDeviceKey("test");
    const storeModePaths = remoteControlKeyStorePaths(storeModeHome);
    fs.chmodSync(storeModePaths.store, 0o640);
    await assert.rejects(
      () => storeModeClient.getDeviceKeyPublic(storeModeKey.keyId),
      /permissions must be 0600/,
    );

    const oversizedHome = path.join(root, "oversized");
    const oversizedPaths = remoteControlKeyStorePaths(oversizedHome);
    fs.mkdirSync(oversizedPaths.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(oversizedPaths.store, Buffer.alloc(1_048_577), { mode: 0o600 });
    await assert.rejects(
      () => createPatchedDeviceKeyClient(oversizedHome).getDeviceKeyPublic("missing"),
      /exceeds size limit/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux device-key store enforces its schema and key-count boundary", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-count-"));
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    const created = await client.createDeviceKey("test");
    const { store } = remoteControlKeyStorePaths(configHome);
    const persisted = JSON.parse(fs.readFileSync(store, "utf8"));
    const record = persisted.keys[created.keyId];
    const records = (length) => Object.fromEntries(
      Array.from({ length }, (_, index) => {
        const keyId = `key-${index}`;
        return [keyId, { ...record, keyId }];
      }),
    );
    persisted.keys = records(64);
    fs.writeFileSync(store, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    fs.chmodSync(store, 0o600);
    assert.equal((await client.getDeviceKeyPublic("key-0")).keyId, "key-0");

    persisted.keys = records(65);
    fs.writeFileSync(store, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    await assert.rejects(() => client.getDeviceKeyPublic("key-0"), /exceeds key limit/);

    persisted.keys = records(1);
    persisted.keys["key-0"].algorithm = "unexpected";
    fs.writeFileSync(store, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    await assert.rejects(() => client.getDeviceKeyPublic("key-0"), /record is invalid/);

    persisted.keys["key-0"] = { ...record, keyId: "key-0" };
    persisted.version = 3;
    fs.writeFileSync(store, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    await assert.rejects(() => client.getDeviceKeyPublic("key-0"), /schema is invalid/);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("remote mobile control feature participates in ASAR patching and reports", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    withFeatureRootEnv(root, () => {
      const source = syntheticMainBundle();
      const patched = patchMainBundleSource(source, null);
      assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);

      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-app-"));
      try {
        const { buildDir, assetsDir } = writeRspackRemoteMobileApp(tempApp);
        const report = createPatchReport();
        const patchOptions = { corePatchRoot: path.join(tempApp, "empty-core") };
        patchExtractedApp(tempApp, { ...patchOptions, report });

        const readMain = (key) => fs.readFileSync(path.join(buildDir, RSPACK_REMOTE_MOBILE_MAIN[key]), "utf8");
        const readAsset = (key) => fs.readFileSync(path.join(assetsDir, RSPACK_REMOTE_MOBILE_ASSETS[key]), "utf8");
        assert.match(readMain("deviceKey"), /codexLinuxRemoteControlDeviceKeyClient/);
        assert.match(readMain("appServer"), /codexLinuxRemoteMobileLocalAppServerArgs/);
        assert.match(readMain("appServer"), /`--remote-control`/);
        assert.match(readMain("featureSync"), /\{\.\.\.e,remote_control:!0\}/);
        assert.match(readAsset("loadGate"), /codexLinuxRemoteControlLoadGateEnabled/);
        for (const key of ["visibility", "visibilityCopy"]) {
          assert.match(readAsset(key), /codexLinuxRemoteControlVisibilityEnabled/);
        }
        const settings = readAsset("settings");
        assert.match(settings, /codexLinuxRemoteControlOutboundTabGate/);
        assert.match(settings, /codexLinuxRemoteControlResetMobileSetupAfterRevoke/);
        assert.match(settings, /codexLinuxRemoteConnectionsRefreshNow/);
        assert.match(settings, /window\.setInterval\(\(\)=>\{n\(\)\},5e3\)/);
        assert.match(settings, /Control this Linux desktop/);
        assert.match(settings, /SSH connections from this Linux desktop/);
        assert.match(readAsset("mobileSetup"), /Connect your phone to this Linux desktop/);
        assert.match(readAsset("mobileSetup"), /apps on this Linux desktop/);
        assert.match(readAsset("terminalStatus"), /codexLinuxRemoteTerminalStatusWaitingOnUserInput/);
        const signals = readAsset("managerSignals");
        assert.match(signals, /codexLinuxRemoteControlShouldReadStatus/);
        assert.match(signals, /codexLinuxRemoteControlStatusWaitMs/);
        assert.match(signals, /codexLinuxRemoteMobileReasoningSummaryNone/);
        assert.match(signals, /codexLinuxRemoteMobileConversationHydration/);
        assert.match(readAsset("bridge"), /codexLinuxRemoteControlEnablementBridge/);
        assert.match(readAsset("bridge"), /codexLinuxRemoteControlEnableForHostParams/);
        assert.match(readAsset("activeStatus"), /codexLinuxRemoteMobileActiveStatus/);

        const statuses = Object.fromEntries(report.patches
          .filter((patch) => patch.featureId === "remote-mobile-control")
          .map((patch) => [patch.name.replace("feature:remote-mobile-control:", ""), patch.status]));
        assert.equal(report.patches.some((patch) => patch.sourceKind === "core"), false);
        for (const id of [
          "linux-remote-control-device-key",
          "linux-remote-control-client-revocation-recovery",
          "linux-remote-mobile-app-server-remote-control",
          "linux-remote-control-load-gate",
          "linux-remote-control-feature-sync",
          "linux-remote-control-visibility",
          "linux-remote-control-copy",
          "linux-remote-control-settings-ux",
          "linux-remote-control-client-revoke-setup-reset",
          "linux-remote-connections-refresh",
          "linux-remote-mobile-reasoning-summary-none",
          "linux-remote-mobile-conversation-hydration",
          "linux-remote-terminal-status-recovery",
          "linux-remote-control-status-read-guard",
          "linux-remote-control-status-wait",
          "linux-remote-control-enable-for-host-params",
          "linux-remote-control-enablement-bridge",
          "linux-remote-mobile-active-status",
        ]) {
          assert.equal(statuses[id], "applied", id);
        }
        assert.equal(statuses["linux-remote-control-auto-connect-contract"], "already-applied");

        const secondReport = createPatchReport();
        patchExtractedApp(tempApp, { ...patchOptions, report: secondReport });
        for (const id of [
          "linux-remote-terminal-status-recovery",
          "linux-remote-control-enablement-bridge",
          "linux-remote-control-visibility",
          "linux-remote-control-status-read-guard",
        ]) {
          assert.ok(
            secondReport.patches.some((patch) =>
              patch.name === `feature:remote-mobile-control:${id}` && patch.status === "already-applied"),
            id,
          );
        }
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});


const SIGNED_APP = process.env.CODEX_SIGNED_EXTRACTED_APP;

function signedMainProcessChunks() {
  const buildDir = path.join(SIGNED_APP, ".vite", "build");
  return fs.readdirSync(buildDir)
    .filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name))
    .map((name) => ({ name, source: fs.readFileSync(path.join(buildDir, name), "utf8") }));
}

function applyToSignedChunks(patchFn) {
  const chunks = signedMainProcessChunks();
  assert.ok(chunks.length > 0);
  const changed = [];
  for (const chunk of chunks) {
    const result = captureWarns(() => patchFn(chunk.source));
    if (result.value !== chunk.source) {
      changed.push({ ...chunk, patched: result.value, warnings: result.warnings });
    } else {
      // Chunks without the anchor must report drift, never a silent no-op
      // that the engine would record as already applied.
      assert.equal(result.warnings.length, 1, chunk.name);
    }
  }
  assert.equal(changed.length, 1);
  const [owner] = changed;
  assert.deepEqual(owner.warnings, []);
  const reapplied = captureWarns(() => patchFn(owner.patched));
  assert.equal(reapplied.value, owner.patched);
  assert.deepEqual(reapplied.warnings, []);
  new vm.Script(owner.patched, { filename: owner.name });
  return owner;
}

test(
  "signed main-process chunk gets the Linux device-key addon behind the upstream provider",
  { skip: SIGNED_APP == null },
  async () => {
    const owner = applyToSignedChunks(applyLinuxRemoteControlDeviceKeyPatch);
    const { patched } = owner;
    const construction = patched.match(
      /this\.remoteControlDeviceKeyClient=process\.platform===`linux`\?codexLinuxRemoteControlDeviceKeyClient\(([\w$]+)\):new \1\(/u,
    );
    assert.notEqual(construction, null);
    const provider = construction[1];

    // Run the injected addon with the signed provider classes and payload
    // validators exactly as they ship: from the injected declarations through
    // the base provider, the signing subclass, and its module-level validators.
    // The base getAddon (native addon + schema) is replaced and never runs.
    const injectedStart = patched.indexOf("const codexLinuxRemoteControlPath=");
    const providerStart = patched.indexOf(`class ${provider} extends `, injectedStart);
    assert.ok(providerStart > injectedStart);
    const sliceEnd = patched.indexOf("class ", providerStart + 1);
    const slice = patched.slice(injectedStart, sliceEnd);

    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-signed-key-"));
    try {
      const context = {
        Buffer,
        clearTimeout,
        console,
        module: { exports: {} },
        process: { env: { XDG_CONFIG_HOME: configHome }, getuid: process.getuid.bind(process), pid: process.pid, platform: "linux" },
        require,
        setTimeout,
        __filename: path.join(configHome, owner.name),
      };
      vm.runInNewContext(
        `${slice};module.exports=codexLinuxRemoteControlDeviceKeyClient(${provider});`,
        context,
      );
      const client = context.module.exports;
      const created = await client.createDeviceKey();
      assert.equal(created.algorithm, "ecdsa_p256_sha256");
      const signature = await client.signDeviceKey(created.keyId, validEnrollmentPayload());
      const signedPayload = Buffer.from(signature.signedPayloadBase64, "base64");
      assert.equal(JSON.parse(signedPayload.toString("utf8")).domain, "codex-device-key-sign-payload/v1");
      const publicKey = crypto.createPublicKey({
        format: "der",
        key: Buffer.from(created.publicKeySpkiDerBase64, "base64"),
        type: "spki",
      });
      assert.equal(
        crypto.verify("sha256", signedPayload, publicKey, Buffer.from(signature.signatureDerBase64, "base64")),
        true,
      );
      await assert.rejects(
        () => client.signDeviceKey(created.keyId, validEnrollmentPayload({ nonce: "short" })),
        /Invalid remote-control device-key nonce/u,
      );
      await client.deleteDeviceKey(created.keyId);
      await assert.rejects(() => client.getDeviceKeyPublic(created.keyId), /not found/);
    } finally {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  },
);

test(
  "signed main-process chunk recovers bare 403 key-material errors",
  { skip: SIGNED_APP == null },
  () => {
    const { patched } = applyToSignedChunks(applyLinuxRemoteControlClientRevocationRecoveryPatch);
    const predicate = patched.match(
      /\("Remote control request failed \(404\): Remote-control client not found"===([\w$]+)\.message(?:\|\|"[^"]+"===\1\.message)+\)/u,
    );
    assert.notEqual(predicate, null);
    const checks = predicate[0].slice(1, -1).split("||");
    for (const message of [
      "Remote-control client has been revoked",
      "Remote-control client key material missing",
      "Remote control request failed (403): Remote-control client key material missing",
    ]) {
      assert.ok(checks.includes(`"${message}"===${predicate[1]}.message`), message);
    }
  },
);

test(
  "signed main-process chunk launches the local Desktop app-server with remote control",
  { skip: SIGNED_APP == null },
  () => {
    const { patched } = applyToSignedChunks((source) => {
      const result = applyLinuxRemoteMobileAppServerRemoteControlPatch(source);
      // The extracted-app descriptor filters chunks itself; mirror its warning.
      if (result === source && !hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(source)) {
        console.warn("WARN: no local Desktop app-server base args");
      }
      return result;
    });
    assert.equal(hasLinuxRemoteMobileLocalAppServerRemoteControlPatch(patched), true);
    assert.equal(patched.match(/codexLinuxStartupCommandAppServerArgs\([\w$]+\.args,[\w$]+\.startupCommand\)/gu).length, 2);
    assert.ok(patched.startsWith("function codexLinuxRemoteMobileLocalAppServerArgs(e,t){"));
    assert.match(patched.slice(0, 2000), /\}function codexLinuxStartupCommandAppServerArgs\(e,t\)\{.*?\}exports\.ids=\[/u);
  },
);

test(
  "signed webview status subscription gets the Linux remote status read guard",
  { skip: SIGNED_APP == null },
  () => {
    const assetsDir = path.join(SIGNED_APP, "webview", "assets");
    const owners = findWebviewAssetsContaining(SIGNED_APP, ['"remoteControl/status/read",void 0'])
      .map((name) => fs.readFileSync(path.join(assetsDir, name), "utf8"));
    assert.equal(owners.length, 1);
    const result = captureWarns(() => applyLinuxRemoteControlStatusReadGuardPatch(owners[0]));
    assert.notEqual(result.value, owners[0]);
    assert.deepEqual(result.warnings, []);
    assert.equal(applyLinuxRemoteControlStatusReadGuardPatch(result.value), result.value);
    assert.ok(/codexLinuxRemoteControlShouldReadStatus\([\w$]+\)\?\(0,[\w$]+\.[\w$]+\)\([\w$]+\.sendRequest\("remoteControl\/status\/read"/u.test(result.value));
  },
);

test(
  "signed main-process chunk syncs remote_control enablement for the local app server",
  { skip: SIGNED_APP == null },
  () => {
    const { patched } = applyToSignedChunks(applyLinuxRemoteControlFeatureSyncPatch);
    assert.match(patched, /sendAppServerRequest\("experimentalFeature\/enablement\/set",\{enablement:codexLinuxRemoteControlFeatureSyncEnabled\([\w$]+,[\w$]+\.connection\.hostId\)\},[\w$]+\)/u);
  },
);

test(
  "signed webview chunks satisfy every remote mobile webview contract",
  { skip: SIGNED_APP == null, timeout: 300_000 },
  () => {
    const assetsDir = path.join(SIGNED_APP, "webview", "assets");
    const patchedAssets = new Map();
    const descriptors = remoteMobilePatchDescriptors
      .filter((descriptor) => descriptor.phase === "webview-asset")
      .sort((left, right) => left.order - right.order);
    for (const descriptor of descriptors) {
      let names = findWebviewAssetsContaining(SIGNED_APP, descriptor.assetNeedles);
      const read = (name) => patchedAssets.get(name) ?? fs.readFileSync(path.join(assetsDir, name), "utf8");
      if (descriptor.assetMatch != null) names = names.filter((name) => descriptor.assetMatch(read(name), name, {}));
      assert.ok(names.length > 0, descriptor.id);
      if (descriptor.assetMatch != null) assert.equal(names.length, 1, descriptor.id);
      for (const name of names) {
        const source = read(name);
        const result = captureWarns(() => descriptor.apply(source, {}));
        assert.deepEqual(result.warnings, [], `${descriptor.id} ${name}`);
        assert.notEqual(result.value, source, `${descriptor.id} ${name}`);
        assert.equal(descriptor.apply(result.value, {}), result.value, `${descriptor.id} ${name}`);
        patchedAssets.set(name, result.value);
      }
    }
    // The mobile setup flag the revoke reset clears is still a global-state
    // key. Rspack may carry the same key registry in multiple chunks.
    const keys = findWebviewAssetsContaining(SIGNED_APP, ['CODEX_MOBILE_SETUP_COMPLETED:"codex-mobile-has-connected-device"']);
    assert.ok(keys.length > 0);
    for (const name of keys) {
      const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
      assert.equal(source.split('CODEX_MOBILE_SETUP_COMPLETED:"codex-mobile-has-connected-device"').length - 1, 1, name);
    }
    for (const [name, patched] of patchedAssets) {
      execFileSyncForModuleCheck(patched, name);
    }
  },
);

function execFileSyncForModuleCheck(source, name) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, stdio: ["pipe", "ignore", "ignore"] });
  assert.equal(result.status, 0, `${name} must remain a parseable ES module`);
}
