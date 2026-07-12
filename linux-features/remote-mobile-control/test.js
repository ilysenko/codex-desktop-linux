#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
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
  applyLinuxRemoteMobileChromeBridgePatch,
  applyLinuxRemoteMobileCompletedItemRecoveryPatch,
  applyLinuxRemoteMobileConversationHydrationPatch,
  applyLinuxRemoteTerminalStatusRecoveryPatch,
  applyLinuxRemoteControlStatusReadGuardPatch,
  applyLinuxRemoteControlStatusWaitPatch,
  applyLinuxRemoteConnectionsRefreshPatch,
  applyLinuxRemoteControlSettingsUxPatch,
  applyLinuxRemoteControlVisibilityPatch,
} = require("./patch.js");
const remoteMobilePatchDescriptors = require("./patch.js");

const REPO_ROOT = path.resolve(__dirname, "../..");
const OLD_REMOTE_CONTROL_GATE_ASSET =
  "app-initial~app-main~hotkey-window-new-thread-page~hotkey-window-home-page~composer-utility-bar-test.js";
const OLD_APP_SERVER_MANAGER_ASSET =
  "app-initial~app-main~hotkey-window-thread-page~thread-app-shell-chrome~header~remote-conver~test.js";
const CURRENT_REMOTE_CONVERSATION_ASSET =
  "app-initial~app-main~worktree-init-v2-page~remote-conversation-page~new-thread-panel-page~o~test.js";
const LATEST_REMOTE_CONVERSATION_ASSET =
  "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~glxlkd48-test.js";
const CURRENT_PROJECTLESS_REMOTE_TASK_ASSET =
  "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-test.js";
const UNIFIED_REMOTE_CONVERSATION_ASSET =
  "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-test.js";
const CURRENT_APP_MAIN_PAGE_ASSET =
  "app-initial~app-main~page-test.js";
const CURRENT_REMOTE_CONNECTIONS_VISIBILITY_ASSET =
  "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-test.js";
const CURRENT_REMOTE_CONVERSATION_STATUS_ASSET =
  "app-initial~app-main~projects-index-page~remote-conversation-page-test.js";

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
    ["linux-remote-mobile-conversation-hydration", "mobile-host"],
    ["linux-remote-mobile-completed-item-recovery", "mobile-host"],
    ["linux-remote-terminal-status-recovery", "mobile-host"],
    ["linux-remote-control-status-read-guard", "shared-boundary"],
    ["linux-remote-control-status-wait", "shared-boundary"],
    ["linux-remote-control-enable-for-host-params", "shared-boundary"],
    ["linux-remote-control-enablement-bridge", "shared-boundary"],
    ["linux-remote-mobile-active-status", "mobile-host"],
  ]);

  assert.equal(documented.size, rows.length, "topology table must not repeat descriptor ids");
  assert.deepEqual([...documented.keys()].sort(), descriptorIds.sort());
  assert.deepEqual([...documented].sort(), [...expected].sort());
  assert.match(readme, /`applyLinuxRemoteControlSshInstallActionPatch`[\s\S]*`remote-ssh`/);
  assert.match(readme, /`applyLinuxRemoteControlSshInstallReleasePatch`[\s\S]*`remote-ssh`/);
  assert.match(readme, /`set-experimental-feature-enablement-for-host`/);
  assert.match(readme, /`refresh-remote-connections`/);
  assert.match(readme, /`get-global-state`/);
});

function syntheticMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),h=require(`node:child_process`),b={createRequire:()=>()=>({})};",
    "function TV(e){return Buffer.from(JSON.stringify(e),`utf8`)}",
    "var bV=(0,b.createRequire)(__filename),xV=`remote-control-device-key.node`,SV=`codex-device-key-sign-payload/v1`;",
    "function wV({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=bV(i.join(e,`native`,xV)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=TV(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await hV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),pV))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticCurrentMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),h=require(`node:child_process`),b={createRequire:()=>()=>({})};",
    "function mz(e){return Buffer.from(JSON.stringify({domain:`codex-device-key-sign-payload/v1`,payload:e}),`utf8`)}",
    "var lz=(0,b.createRequire)(__filename),uz=`remote-control-device-key.node`,dz=`codex-device-key-sign-payload/v1`;",
    "function pz({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=lz((0,i.join)(e,`native`,uz)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=mz(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function vV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await yV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),_V))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticCryptoAliasCollisionMainBundle() {
  return [
    "let a=require(`node:path`),o=require(`node:fs`),c=require(`node:crypto`),h=require(`node:child_process`),b={createRequire:()=>()=>({})};",
    "function mz(e){return Buffer.from(JSON.stringify({domain:`codex-device-key-sign-payload/v1`,payload:e}),`utf8`)}",
    "var lz=(0,b.createRequire)(__filename),uz=`remote-control-device-key.node`,dz=`codex-device-key-sign-payload/v1`;",
    "function pz({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=lz((0,a.join)(e,`native`,uz)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=mz(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
  ].join("");
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
    __filename: path.join(path.resolve(configHome), "main.js"),
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
  vm.runInNewContext(`${patched};module.exports=wV({resourcesPath:null});`, context);
  return context.module.exports;
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

function syntheticRecoverableErrorPredicateBundle() {
  return "function Bd(e){return e instanceof Error?e.message.startsWith(`Remote control request failed (404):`)||e.message===`Remote control request failed (401): Remote-control client enrollment is incomplete`||e.message===`Remote control request failed (403): Remote-control client key material missing`:!1}";
}

function syntheticRemoteConnectionVisibilityBundle() {
  return "function d(){return true}function f(){return c(`1042620455`)}function p(){return []}export{d as n,f as r,p as t};";
}

function syntheticAppMainFeatureSyncBundle() {
  return [
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`],vI=`remote_plugin`;",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n,!0);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r}).catch(n=>{q.error(`Failed to sync experimental feature enablement`,{sensitive:{error:n}})})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e,t){let n={};for(let r of GF){let i=e[r];i!=null&&(n[r]=i)}return n[vI]=t,n}",
  ].join("");
}

function syntheticCurrentAppMainFeatureSyncBundle() {
  return [
    "var gI=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`],vI=`remote_plugin`,Ir=`local-host`,Vt=`hosts`,Ro=`features-query`,G={error(){}};",
    "function yI(){let e=new Map,o=()=>{if(ln(`set-default-feature-overrides`,{overrides:features??null}),features==null)return;let i=bI(features,!0),o=store.get(Ir),s=new Set(store.get(Vt).filter(e=>e===o||xn(store,e).state===`connected`));for(let t of e.keys())s.has(t)||e.delete(t);let c=store.get(Vt).filter(e=>s.has(e)).flatMap(t=>(0,dv.default)(e.get(t),i)?[]:(e.set(t,i),[ln(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:i}).catch(n=>{e.delete(t),G.error(`Failed to sync experimental feature enablement`,{safe:{hostId:t},sensitive:{error:n}})})]));c.length!==0&&Promise.all(c).then(()=>{query.invalidateQueries({queryKey:Ro})})};return o()}",
    "function bI(e,t){let n={};for(let t of gI){let r=e[t];r!=null&&(n[t]=r)}return n[vI]=t,n}",
  ].join("");
}

function syntheticCurrentVisibilityBundle() {
  return "function Et({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)}export{Et as t};";
}

function syntheticCurrentUsePluginVisibilityBundle() {
  return "function ke({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}export{ke as l};";
}

function syntheticMobileConnectedSettingsBundle() {
  return "let y={id:`codexMobile.setupDialog.connected.computerUse.description`,defaultMessage:`Let Codex control the apps on your Mac.`,description:`Description for enabling Computer Use after mobile setup`};";
}

function syntheticRemoteConnectionsSettingsCopyBundle() {
  return [
    syntheticCurrentVisibilityBundle(),
    "let platformLabel={id:`settings.remoteConnections.platform.mac`,defaultMessage:`Mac`,description:`Short label for a Mac device`};",
    "let a={id:`settings.remoteConnections.tabs.controlThisMac`,defaultMessage:`Control this Mac`,description:`Tab label for settings that let other devices control this computer`};",
    "let b={id:`settings.remoteControlConnections.devices.title`,defaultMessage:`Devices that can control this Mac`,description:`Header title for devices that can control this Mac`};",
    "let c={id:`settings.remoteConnections.accessOtherDevices.header.title`,defaultMessage:`Devices you can control from this Mac`,description:`Header title for the devices this computer can access`};",
    "let d={id:`settings.remoteConnections.ssh.header.title`,defaultMessage:`SSH connections from this Mac`,description:`Header title for SSH connections from this Mac`};",
    "let e={id:`settings.remoteControlConnections.keepAwake.title`,defaultMessage:`Keep this Mac awake`,description:`Keep awake title`};",
  ].join("");
}

function syntheticMobileSetupFlowCopyBundle() {
  return [
    "let a={id:`codexMobile.setupDialog.connected.lockedComputerUse.title`,defaultMessage:`Use your Mac apps while locked`,description:`Title for enabling Locked Computer Use after mobile setup`};",
    "let b={id:`codexMobile.setupDialog.connected.lockedComputerUse.description`,defaultMessage:`Control Mac apps from your phone`,description:`Description for enabling Locked Computer Use after mobile setup`};",
    "let c={id:`codexMobile.setupDialog.connected.computerUse.description`,defaultMessage:`Let Codex control the apps on your Mac`,description:`Description for enabling Computer Use after mobile setup`};",
    "let d={id:`codexMobile.setupPage.initial.heading`,defaultMessage:`Connect your phone to this Mac`,description:`Heading for Codex mobile setup`};",
  ].join("");
}

function syntheticSettingsBundle() {
  return [
    "const o=`linux`,Q={jsx(){},jsxs(){}};",
    "tabs:[{key:`control-this-mac`,name:o===`windows`?(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.controlThisMac.windows`,defaultMessage:`Control this PC`,description:`Tab label for settings that let other devices control this Windows device`}):(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.controlThisMac`,defaultMessage:`Control this Mac`,description:`Tab label for settings that let other devices control this computer`})},{key:`access-other-devices`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.accessOtherDevices`,defaultMessage:`Control other devices`,description:`Tab label for settings that let this computer control other devices`})},{key:`ssh`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.ssh`,defaultMessage:`SSH`,description:`Tab label for SSH remote connections`})}],selectedKey:je,variant:`underline`,onSelect:se}",
    "tabs:[{key:`access-other-devices`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.accessOtherDevices`,defaultMessage:`Control other devices`,description:`Tab label for settings that let this computer control other devices`})},{key:`ssh`,name:(0,Q.jsx)(z,{id:`settings.remoteConnections.tabs.ssh`,defaultMessage:`SSH`,description:`Tab label for SSH remote connections`})}],selectedKey:je,variant:`underline`,onSelect:se}",
    "const a=`Control this Mac from your phone or other device`,b=`Add device to control this Mac remotely`,c=`Devices that can control this Mac`,d=`Keep Mac awake`,e=`Allow this Mac to be discovered and controlled`,f=`Control other devices from this Mac`,g=`Authorize this Mac to control other devices signed in to your ChatGPT account`,h=`Devices you can control from this Mac`;",
    "let xe=!Pe&&(Te?.code===`remote-codex-not-found`||Te?.code===`update-required`);Ce=Ae==null||xe?null:Re({action:Ae.action,connection:Ee});",
    "function nr(e,t){return e.displayName.localeCompare(t.displayName)}",
    "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}",
  ].join("");
}

function syntheticSshInstallSettingsBundle() {
  return [
    "function pn({action:e,disabled:t,hostId:n,installCodexPending:r,onAuthenticate:i,onInstallCodex:a}){if(e==null)return null;switch(e.kind){case`install-codex`:return{disabled:t,label:e.label,loading:r,loadingLabel:e.loadingLabel,renderInElectronOnly:!0,tooltipText:e.tooltipText,onClick:()=>a(n)};case`login`:return{label:e.label,onClick:()=>i(n)};case`settings`:return null}}",
    "let et=R(`install-remote-codex`),vt=(e,t,n)=>{globalThis.__states.push({hostId:e,state:t,error:n})},bt=e=>{et.mutate({hostId:e},{onSuccess:({state:t,error:n})=>{vt(e,t,n)}})};",
    "function un(e){let t=(0,$.c)(86),{connection:n,disabled:r,installCodexPending:i,onAuthenticate:a,onEdit:o,onInstallCodex:s,onLogoutConnection:c,onRemove:l,onShowDetails:u,onToggleConnection:d}=e,f=ee(),{appServerVersion:p,error:m,installedCodexVersion:h,state:g}=De(n.hostId),_=n.displayName,v;let T=w,E=oe(`2153867414`),D,O,k,A,j,M;if(t[8]!==p||t[9]!==n.hostId||t[10]!==r||t[11]!==m||t[12]!==i||t[13]!==h||t[14]!==f||t[15]!==a||t[16]!==s||t[17]!==E||t[18]!==g){k=fn({appServerVersion:p,installedCodexVersion:h,state:g}),D=g===`connected`||m?.code===`login-required`||m?.code===`update-required`||m?.code===`restart-required`;let{statusError:e,isRestartAvailableNotice:o,statusState:c}=dn({error:m,restartAvailableNotice:k,state:g});A=e,O=o,j=c==null?null:Ne(f,{canLogin:!0,error:A,state:c,surface:`connections-row`});let l=!E&&(A?.code===`remote-codex-not-found`||A?.code===`update-required`);M=j==null||l?null:pn({action:j.action,disabled:r,hostId:n.hostId,installCodexPending:i,onAuthenticate:a,onInstallCodex:s}),t[8]=p,t[9]=n.hostId,t[10]=r,t[11]=m,t[12]=i,t[13]=h,t[14]=f,t[15]=a,t[16]=s,t[17]=E,t[18]=g,t[19]=D,t[20]=O,t[21]=k,t[22]=A,t[23]=j,t[24]=M}else D=t[19],O=t[20],k=t[21],A=t[22],j=t[23],M=t[24];return M}",
    "function nr(e,t){return e.displayName.localeCompare(t.displayName)}",
  ].join("");
}

function syntheticSettingsRefreshBundle() {
  return [
    "var Qn=15e3,Z=React;",
    "function tr(){let $=useEffectEvent(async e=>{await P(`refresh-remote-connections`,{signal:e})});",
    "(0,Z.useEffect)(()=>{let e=null,t=!1,n=async()=>{if(!t){t=!0,e=new AbortController;try{await $(e.signal)}finally{e=null,t=!1}}},r=window.setInterval(()=>{n()},Qn);return()=>{e?.abort(),window.clearInterval(r)}},[]);",
    "return null}",
  ].join("");
}

function syntheticAppServerLaunchBundle() {
  return "var Uz=`Codex Desktop`,Wz=[`-c`,`features.code_mode_host=true`,`app-server`,`--analytics-default-enabled`],Gz={appServerVersion:`current`};";
}

function syntheticCurrentSettingsBundle() {
  return [
    "const i=`linux`,Q={jsx(){},jsxs(){}};",
    "tabs:[{key:`control-this-mac`,name:i===`windows`?(0,Q.jsx)(N,{id:`settings.remoteConnections.tabs.controlThisMac.windows`,defaultMessage:`Control this PC`,description:`Tab label for settings that let other devices control this Windows device`}):(0,Q.jsx)(N,{id:`settings.remoteConnections.tabs.controlThisMac`,defaultMessage:`Control this Mac`,description:`Tab label for settings that let other devices control this computer`})},{key:`access-other-devices`,name:(0,Q.jsx)(N,{id:`settings.remoteConnections.tabs.accessOtherDevices`,defaultMessage:`Control other devices`,description:`Tab label for settings that let this computer control other devices`})},{key:`ssh`,name:(0,Q.jsx)(N,{id:`settings.remoteConnections.tabs.ssh`,defaultMessage:`SSH`,description:`Tab label for SSH remote connections`})}],selectedKey:Pe,variant:`underline`,onSelect:le}",
    "tabs:[{key:`access-other-devices`,name:(0,Q.jsx)(N,{id:`settings.remoteConnections.tabs.accessOtherDevices`,defaultMessage:`Control other devices`,description:`Tab label for settings that let this computer control other devices`})},{key:`ssh`,name:(0,Q.jsx)(N,{id:`settings.remoteConnections.tabs.ssh`,defaultMessage:`SSH`,description:`Tab label for SSH remote connections`})}],selectedKey:Pe,variant:`underline`,onSelect:le}",
    "const a=`Control this Mac from your phone or other device`,b=`Add device to control this Mac remotely`,c=`Devices that can control this Mac`,d=`Keep Mac awake`,e=`Allow this Mac to be discovered and controlled`,f=`Control other devices from this Mac`,g=`Authorize this Mac to control other devices signed in to your ChatGPT account`,h=`Devices you can control from this Mac`;",
    "function $n(e,t){return e.displayName.localeCompare(t.displayName)}",
    "function er({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}",
  ].join("");
}

function syntheticCurrentSettingsRefreshBundle() {
  return [
    "var Jn=`[remote-connections/settings]`,Yn=15e3,Xn=[],Zn=[];",
    "function Qn(){let ge=me(),et=!1,ne=B,ft=(0,Z.useEffectEvent)(async e=>{if(!et)try{let t=[];t.push(ne(`refresh-remote-connections`,{signal:e})),ge&&t.push(ne(`refresh-remote-control-connections`,{signal:e})),await Promise.all(t)}catch(e){if(e instanceof DOMException&&e.name===`AbortError`)return;M.debug(`${Jn} auto_refresh_failed`,{safe:{},sensitive:{error:e}})}});",
    "(0,Z.useEffect)(()=>{let e=null,t=!1,n=async()=>{if(!t){t=!0,e=new AbortController;try{await ft(e.signal)}finally{e=null,t=!1}}},r=window.setInterval(()=>{n()},Yn);return()=>{e?.abort(),window.clearInterval(r)}},[]);return null}",
  ].join("");
}

function syntheticCurrentRevokeSetupResetBundle() {
  return [
    "let Rt={},_r={},ht={},ot={CODEX_MOBILE_SETUP_COMPLETED:`mobile-setup-completed`,keepRemoteControlAwakeWhilePluggedIn:`keep-awake`};",
    "function we(){return{globalState:{\"mobile-setup-completed\":!0},query:{snapshot(){return{data:[],setData(e){this.data=e(this.data)},invalidate(){this.invalidated=!0}}}},events:[]}}",
    "function Fe(e,t,n){e.globalState[t]=n}",
    "function qe(e,t,n){e.events.push(n)}",
    "function i(){return[`desktop_1`]}",
    "var Kr=`remote-control-client-revoke-success`,qr=`remote-control-client-revoke-error`;",
    "function $r(){return ot.CODEX_MOBILE_SETUP_COMPLETED}",
    "function ei(){let i=we(Rt),s=!1,m=e=>{Fe(i,ot.keepRemoteControlAwakeWhilePluggedIn,e)};return{s,m}}",
    "function ni(e){let t={},{mode:n,oneToOnePairingInAppEnabled:r}=e,a=we(Rt),[m]=i(`local_remote_control_client_id`),k=a.query.snapshot(_r),Se={onRevoked:e=>{k.setData(t=>t?.filter(t=>t.clientId!==e)),k.invalidate()},onRevokeResult:e=>{qe(a,ht,{result:e})}};return{handler:Se.onRevoked,query:k,store:a}}",
  ].join("");
}

function syntheticChromeBrowserClientBundle() {
  return [
    "var e2=[\"chrome\",\"iab\",\"cdp\"];function ly(e){return e2.some(t=>t===e)}var dy=\"BROWSER_USE_AVAILABLE_BACKENDS\";",
    "function Su(e){return globalThis[e]??null}function vy(e){return Array.isArray(e)?e:String(e).split(\",\")}",
    "function _y(){let e=Su(dy);return e==null?null:vy(e).filter(ly)}",
  ].join("");
}

function syntheticCurrentChromeBrowserClientBundle() {
  return [
    "var CN=[\"chrome\",\"iab\",\"cdp\"];function m_(e){return CN.some(t=>t===e)}",
    "var y_=\"BROWSER_USE_AVAILABLE_BACKENDS\";",
    "function nl(e){return globalThis[e]??null}function F_(e){return Array.isArray(e)?e:String(e).split(\",\")}",
    "function N_(){let e=nl(y_);return e==null?null:F_(e).filter(m_)}",
  ].join("");
}

function syntheticModernChromeBrowserClientBundle() {
  return [
    "var wU=[\"chrome\",\"iab\",\"cdp\"];function Jv(t){return wU.some(e=>e===t)}",
    "var Qv=\"BROWSER_USE_AVAILABLE_BACKENDS\";",
    "class Browsers{constructor(e=null){this.browserPreference=e}async getForUrl(){}preferredWindowIdFor(e){return this.browserPreference?.preferredWindowId}}",
  ].join("");
}

function syntheticAppServerManagerSignalsBundle() {
  return [
    "function Of({conversationId:e,conversations:t,getWorkspaceBrowserRoot:n,getWorkspaceKind:r,hostId:i,setConversation:a,thread:o,threadsById:s,updateConversationState:c}){let h=o.status??null;if(t.has(e)){c(e,e=>{e.resumeState===`needs_resume`&&(e.threadRuntimeStatus=h)});return}}",
    "class T{onNotification(e,t){let n={method:e,params:t};switch(n.method){case`turn/started`:{let{threadId:e,turn:t}=n.params,r=I(e);if(!this.conversations.get(r)){z.error(`Received turn/started for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}this.markConversationStreaming(r),this.updateConversationState(r,e=>{});break}case`turn/completed`:{if(this.frameTextDeltaQueue.drainBefore(()=>{this.onNotification(`turn/completed`,n.params)}))break;let{threadId:e,turn:t}=n.params,r=I(e);if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}break}case`item/started`:{let{item:e,threadId:t,turnId:r,startedAtMs:i}=n.params,a=I(t);if(!this.conversations.get(a)){z.error(`Received item/started for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}this.markConversationStreaming(a),this.updateConversationState(a,t=>{});break}case`item/completed`:{if(this.frameTextDeltaQueue.drainBefore(()=>{this.onNotification(`item/completed`,n.params)}))break;let{item:e,threadId:t,turnId:r,completedAtMs:i}=n.params,a=I(t);if(!this.conversations.get(a)){z.error(`Received item/completed for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}this.updateConversationState(a,t=>{});break}}}}",
  ].join("");
}

function syntheticCompletedItemRecoveryBundle() {
  return [
    "class U{onNotification(e,t){let n={method:e,params:t};switch(n.method){case`item/completed`:{if(this.frameTextDeltaQueue.drainBefore(()=>{this.onNotification(`item/completed`,n.params)}))break;",
    "let{item:e,threadId:t,turnId:r,completedAtMs:i}=n.params,a=qf(t);if(!this.conversations.get(a)){$.error(`Received item/completed for unknown conversation`,{safe:{conversationId:a},sensitive:{}});break}",
    "this.updateConversationState(a,t=>{let n=e.type===`userMessage`?gI(t,r):r==null?uI(t):fI(t,e=>e.turnId===r);if(!n)return;aR(n);",
    "let a=Jtt({item:e,threadsById:this.threadStore.threadsById,onCollabAgentToolCall:e=>{this.hydrateCollabThreads(e.receiverThreadIds)}}),o=a.type===`contextCompaction`?n.items.find(e=>e.type===`contextCompaction`&&e.id===a.id):null;",
    "if(a.type===`commandExecution`){let e=a.durationMs==null?null:i-a.durationMs;e!=null&&(n.commandExecutionStartedAtMsById??={},n.commandExecutionStartedAtMsById[a.id]??=e)}",
    "let s=FF(a.type===`contextCompaction`?{...a,completed:!0,source:o?.type===`contextCompaction`&&`source`in o?o.source:`automatic`}:a);",
    "if(e.type===`userMessage`){let t=Put(n.items,e.content,n.turnId,n.turnStartedAtMs,!1);if(t!=null){t.status=`accepted`,HI(n,FF({type:`steered`,id:e.id}));return}HI(n,s);return}",
    "if(e.type===`hookPrompt`){bP(n,s);return}",
    "yV(e)&&(n.firstTurnWorkItemStartedAtMs=n.firstTurnWorkItemStartedAtMs??Date.now()),!(e.type!==`subAgentActivity`&&!LB(n,e.id,e.type))&&(e.type,bP(n,s))});break}}}}",
  ].join("");
}

function syntheticRemoteTerminalStatusBundle() {
  return [
    "function LQt({hasInProgressSideChat:e,isResponseInProgress:t,latestTurnHasSystemError:n,resumeState:r,threadRuntimeStatus:i}){return e?`loading`:i?.type===`systemError`?`error`:i?.type===`active`?`loading`:r===`needs_resume`?`idle`:n?`error`:t===!0?`loading`:`idle`}",
    "function RQt({pendingRequestType:e,requests:t,resumeState:n,threadRuntimeStatus:r}){return t==null||n==null?null:n===`needs_resume`?r?.type===`active`&&r.activeFlags.includes(`waitingOnApproval`)&&yi(t)?`approval`:r?.type===`active`&&r.activeFlags.includes(`waitingOnUserInput`)?`response`:null:Zr(e)?`approval`:e===`userInput`?`response`:null}",
    "var IQt,AQt,OQt=e((()=>{G(),Lr(),Tt(),Ni(),kt(),IQt=s(V,(e,{get:t})=>{let n=t(rr,e);return LQt({hasInProgressSideChat:t(Qw,e),isResponseInProgress:t(ki,e),resumeState:t(si,e)??(n==null?null:`needs_resume`),threadRuntimeStatus:t(Or,e)??n?.threadRuntimeStatus??null,latestTurnHasSystemError:t(Ui,e)===!0})}),AQt=s(V,(e,{get:t})=>RQt({pendingRequestType:t(wr,e)?.type??null,requests:t(fi,e),resumeState:t(si,e),threadRuntimeStatus:t(Or,e)}))}))",
  ].join("");
}

function syntheticAppServerManagerStatusBundle() {
  return [
    "var z={error(){}};",
    "var bO={};",
    "function wO(e,t){return e.bump(t)}",
    "function TO(e,t,n){return e.current(t)===n}",
    "function PO(e,t,n){return e.set(bO,t,n)}",
    "function SO(e,t){let n=t.getHostId(),r=wO(e,n),i=e.get(bO,n);t.addNotificationCallback(`remoteControl/status/changed`,({params:t})=>{TO(e,n,r)&&PO(e,n,t)}),t.sendRequest(`remoteControl/status/read`,void 0).then(t=>{e.get(bO,n)===i&&TO(e,n,r)&&PO(e,n,t)}).catch(t=>{TO(e,n,r)&&z.error(`Failed to read remote-control status`,{safe:{},sensitive:{error:t}})})}",
  ].join("");
}

function syntheticCurrentStatusWaitBundle() {
  return [
    "function A5t(e,t,{ignoreCurrentError:n=!1}={}){return new Promise((n,r)=>{let a=!1,o,s=e=>{a||(a=!0,clearTimeout(c),o?.(),e instanceof Error?r(e):n(e))},c=setTimeout(()=>{s(Error(`Timed out waiting for remote control to connect`))},F5t);o=e.watch(()=>{})})}",
    "function V5t(e){return e.subscribe(`remoteControl/status/changed`,()=>{})}",
    "var F5t,SP,CP,wP;F5t=5e3,SP=va(G,e=>null),CP=va(G,e=>!1),wP=ya(G,(e,{get:t})=>t(SP,e));",
  ].join("");
}

function syntheticAppMainActiveStatusBundle() {
  return [
    "function pS({latestTurnStatus:e,resumeState:t,streamRole:n,threadRuntimeStatus:r}){return n==null?t===`needs_resume`?`needs-resume`:`read-only`:n.role===`follower`?`follower`:r?.type===`active`||e===`inProgress`?`active`:`inactive`}",
  ].join("");
}

function syntheticAppMainEnablementBridgeBundle() {
  return [
    "function OF(){let e=(0,Z.c)(6),{checkGate:t,isLoading:n}=sc(),r;e[0]===t?r=e[1]:(r=t(`1042620455`),e[0]=t,e[1]=r);let i=r,a,o;return e[2]!==n||e[3]!==i?(a=()=>{n||$o(`set-remote-control-connections-enabled`,{params:{enabled:i}}).catch(e=>{q.warning(`${DF} sync_failed`,{safe:{slingshotEnabled:i},sensitive:{error:e}})})},o=[n,i],e[2]=n,e[3]=i,e[4]=a,e[5]=o):(a=e[4],o=e[5]),(0,Q.useEffect)(a,o),null}",
    "var DF=`[remote-connections/slingshot-gate-bridge]`;",
  ].join("");
}

function syntheticCurrentAppMainEnablementBridgeBundle() {
  return [
    syntheticAppMainEnablementBridgeBundle(),
    "var handlers={\"set-remote-control-enabled-for-host\":pU((e,{enabled:t})=>e.sendRequest(t?`remoteControl/enable`:`remoteControl/disable`,null))};",
  ].join("");
}

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-feature-test-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(__dirname, path.join(root, "remote-mobile-control"), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
  "CODEX_REMOTE_CONTROL_CODEX_RELEASE",
  "CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED",
  "CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_TIMEOUT_SECONDS",
  "CODEX_REMOTE_CONTROL_FORCE_COLD_START_DAEMON",
  "CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED",
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

test("remote mobile stage hook is idempotent and stages its markers and executable hook", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const featureMarker = path.join(installDir, ".codex-linux", "remote-mobile-control-enabled");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");
    const coldStartHook = path.join(installDir, ".codex-linux", "cold-start.d", "remote-mobile-control");
    const env = {
      ARCH: "x64",
      CODEX_UPSTREAM_APP_DIR: path.join(tempRoot, "upstream-app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    };

    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "globalThis.codexLinuxRemoteMobileAppServerArgs=true;");

    const first = runStageHook(env);
    const second = runStageHook(env);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(fs.readFileSync(featureMarker, "utf8"), "remote-mobile-control\n");
    assert.equal(fs.readFileSync(marker, "utf8"), "version=1\nowner=desktop\n");
    assert.equal(fs.statSync(coldStartHook).mode & 0o777, 0o755);
    assert.equal(
      fs.readFileSync(coldStartHook, "utf8"),
      fs.readFileSync(path.join(__dirname, "cold-start-hook.sh"), "utf8"),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile stage hook removes a stale ownership marker when the patch marker is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");

    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "globalThis.someOtherPatch=true;");
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
    fs.writeFileSync(path.join(buildDir, "main.js"), "globalThis.codexLinuxRemoteMobileAppServerArgs=true;");
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

test("remote mobile cold-start hook removes leaked standalone codex symlink from interactive PATH", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "codex");
    const userCodex = path.join(home, ".local", "bin", "codex");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(path.dirname(userCodex), { recursive: true });
    fs.writeFileSync(standaloneCodex, "#!/usr/bin/env sh\nexit 0\n");
    fs.chmodSync(standaloneCodex, 0o755);
    fs.symlinkSync(standaloneCodex, userCodex);

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(userCodex), false);
    assert.match(result.stdout, /Removed remote mobile control standalone symlink from interactive PATH/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook preserves active CODEX_CLI_PATH standalone symlink", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "bin", "codex");
    const userCodex = path.join(home, ".local", "bin", "codex");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(path.dirname(userCodex), { recursive: true });
    fs.writeFileSync(standaloneCodex, "#!/usr/bin/env sh\nexit 0\n");
    fs.chmodSync(standaloneCodex, 0o755);
    fs.symlinkSync(standaloneCodex, userCodex);

    const result = runColdStartHook({
      CODEX_CLI_PATH: userCodex,
      CODEX_HOME: codexHome,
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readlinkSync(userCodex), standaloneCodex);
    assert.match(result.stdout, /Preserved active CODEX_CLI_PATH symlink/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook preserves symlink resolving to active CODEX_CLI_PATH", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "bin", "codex");
    const userCodex = path.join(home, ".local", "bin", "codex");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(path.dirname(userCodex), { recursive: true });
    fs.writeFileSync(standaloneCodex, "#!/usr/bin/env sh\nexit 0\n");
    fs.chmodSync(standaloneCodex, 0o755);
    fs.symlinkSync(standaloneCodex, userCodex);

    const result = runColdStartHook({
      CODEX_CLI_PATH: standaloneCodex,
      CODEX_HOME: codexHome,
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readlinkSync(userCodex), standaloneCodex);
    assert.match(result.stdout, /Preserved active CODEX_CLI_PATH symlink/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook preserves user codex symlinks outside the standalone runtime", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const userManagedCodex = path.join(tempRoot, "brew", "bin", "codex");
    const userCodex = path.join(home, ".local", "bin", "codex");

    fs.mkdirSync(path.dirname(userManagedCodex), { recursive: true });
    fs.mkdirSync(path.dirname(userCodex), { recursive: true });
    fs.writeFileSync(userManagedCodex, "#!/usr/bin/env sh\nexit 0\n");
    fs.chmodSync(userManagedCodex, 0o755);
    fs.symlinkSync(userManagedCodex, userCodex);

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED: "1",
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readlinkSync(userCodex), userManagedCodex);
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
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "codex");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);
    fs.writeFileSync(
      standaloneCodex,
      `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\nexit 0\n`,
    );
    fs.chmodSync(standaloneCodex, 0o755);

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      CODEX_REMOTE_CONTROL_RUNTIME_AUTO_INSTALL_DISABLED: "1",
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
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "codex");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(path.join(appDir, ".codex-linux"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, ".codex-linux", "desktop-app-server-remote-control-enabled"),
      "desktop-app-server-remote-control\n",
    );
    fs.writeFileSync(standaloneCodex, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\n`);
    fs.chmodSync(standaloneCodex, 0o755);

    const result = runColdStartHook({ CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDir, HOME: home });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Ignoring invalid remote mobile control Desktop owner marker/);
    assert.match(result.stdout, /owner: standalone fallback/);
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
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "codex");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(standaloneCodex, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\n`);
    fs.chmodSync(standaloneCodex, 0o755);

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
    const standaloneCodex = path.join(codexHome, "packages", "standalone", "current", "codex");
    const callsLog = path.join(tempRoot, "calls.log");

    fs.mkdirSync(path.dirname(standaloneCodex), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(standaloneCodex, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\n`);
    fs.chmodSync(standaloneCodex, 0o755);

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

test("remote mobile cold-start hook removes dead standalone daemon pid files when Desktop app-server owns remote-control", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const daemonDir = path.join(codexHome, "app-server-daemon");
    const appDir = path.join(tempRoot, "package", "share", "codex-desktop", "app");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);
    fs.writeFileSync(
      path.join(daemonDir, "app-server.pid"),
      JSON.stringify({ pid: 999999, processStartTime: "fixture" }),
    );
    fs.writeFileSync(
      path.join(daemonDir, "app-server-updater.pid"),
      JSON.stringify({ pid: 999998, processStartTime: "fixture" }),
    );

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(daemonDir, "app-server.pid")), false);
    assert.equal(fs.existsSync(path.join(daemonDir, "app-server-updater.pid")), false);
    assert.match(result.stdout, /Removed stale remote mobile control daemon pid file/);
    assert.match(result.stdout, /owner: desktop \(app-server launches with remote-control enabled\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile cold-start hook preserves live standalone daemon pid files when Desktop app-server owns remote-control", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-cold-start-"));
  try {
    const home = path.join(tempRoot, "home");
    const codexHome = path.join(tempRoot, "codex-home");
    const daemonDir = path.join(codexHome, "app-server-daemon");
    const appDir = path.join(tempRoot, "package", "share", "codex-desktop", "app");
    const pidFile = path.join(daemonDir, "app-server.pid");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    writeDesktopAppServerRemoteControlMarker(appDir);
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, processStartTime: "fixture" }));

    const result = runColdStartHook({
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      HOME: home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(pidFile), true);
    assert.doesNotMatch(result.stdout, /Removed stale remote mobile control daemon pid file/);
    assert.match(result.stdout, /owner: desktop \(app-server launches with remote-control enabled\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile control feature exposes opt-in main-bundle and webview patches", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
      "feature:remote-mobile-control:linux-remote-control-device-key",
      "feature:remote-mobile-control:linux-remote-control-client-revocation-recovery",
      "feature:remote-mobile-control:linux-remote-mobile-app-server-remote-control",
      "feature:remote-mobile-control:linux-remote-control-load-gate",
      "feature:remote-mobile-control:linux-remote-control-feature-sync",
      "feature:remote-mobile-control:linux-remote-control-visibility",
      "feature:remote-mobile-control:linux-remote-control-copy",
      "feature:remote-mobile-control:linux-remote-control-settings-ux",
      "feature:remote-mobile-control:linux-remote-control-client-revoke-setup-reset",
      "feature:remote-mobile-control:linux-remote-connections-refresh",
      "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration",
      "feature:remote-mobile-control:linux-remote-mobile-completed-item-recovery",
      "feature:remote-mobile-control:linux-remote-terminal-status-recovery",
      "feature:remote-mobile-control:linux-remote-control-status-read-guard",
      "feature:remote-mobile-control:linux-remote-control-status-wait",
      "feature:remote-mobile-control:linux-remote-control-enable-for-host-params",
      "feature:remote-mobile-control:linux-remote-control-enablement-bridge",
      "feature:remote-mobile-control:linux-remote-mobile-active-status",
    ]);
    assert.deepEqual(descriptors.map((descriptor) => descriptor.phase), [
      "main-bundle",
      "main-bundle",
      "extracted-app:post-webview",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
      "webview-asset",
    ]);

    const visibilityDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-visibility"
    );
    assert.ok(visibilityDescriptor);
    assert.equal(visibilityDescriptor.pattern.test("remote-connections-settings-fixture.js"), false);
    assert.equal(visibilityDescriptor.pattern.test(CURRENT_REMOTE_CONNECTIONS_VISIBILITY_ASSET), true);
    assert.equal(visibilityDescriptor.pattern.test("use-plugin-install-flow-fixture.js"), false);
    assert.equal(visibilityDescriptor.pattern.test("app-main-fixture.js"), false);

    const featureSyncDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-feature-sync"
    );
    assert.ok(featureSyncDescriptor);
    assert.equal(featureSyncDescriptor.pattern.test(CURRENT_APP_MAIN_PAGE_ASSET), true);
    assert.equal(featureSyncDescriptor.pattern.test("app-main-fixture.js"), false);

    const enableForHostDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-enable-for-host-params"
    );
    assert.ok(enableForHostDescriptor);
    assert.equal(enableForHostDescriptor.pattern.test(CURRENT_APP_MAIN_PAGE_ASSET), true);
    assert.equal(enableForHostDescriptor.pattern.test("app-main-fixture.js"), false);

    const enablementBridgeDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-enablement-bridge"
    );
    assert.ok(enablementBridgeDescriptor);
    assert.equal(enablementBridgeDescriptor.pattern.test(CURRENT_APP_MAIN_PAGE_ASSET), true);
    assert.equal(enablementBridgeDescriptor.pattern.test("app-main-fixture.js"), false);

    const activeStatusDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-mobile-active-status"
    );
    assert.ok(activeStatusDescriptor);
    assert.equal(activeStatusDescriptor.pattern.test(CURRENT_REMOTE_CONVERSATION_STATUS_ASSET), true);
    assert.equal(activeStatusDescriptor.pattern.test("app-main-fixture.js"), false);

    const statusGuardDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-status-read-guard"
    );
    assert.ok(statusGuardDescriptor);
    assert.equal(statusGuardDescriptor.pattern.test(CURRENT_REMOTE_CONVERSATION_ASSET), false);
    assert.equal(statusGuardDescriptor.pattern.test(LATEST_REMOTE_CONVERSATION_ASSET), false);
    assert.equal(statusGuardDescriptor.pattern.test(UNIFIED_REMOTE_CONVERSATION_ASSET), true);
    assert.equal(statusGuardDescriptor.pattern.test(OLD_APP_SERVER_MANAGER_ASSET), false);
    assert.equal(statusGuardDescriptor.pattern.test("app-server-manager-signals-test.js"), false);
    assert.equal(statusGuardDescriptor.pattern.test(CURRENT_PROJECTLESS_REMOTE_TASK_ASSET), false);

    const statusWaitDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-status-wait"
    );
    assert.ok(statusWaitDescriptor);
    assert.equal(statusWaitDescriptor.pattern.test(UNIFIED_REMOTE_CONVERSATION_ASSET), true);
    assert.equal(statusWaitDescriptor.pattern.test(OLD_APP_SERVER_MANAGER_ASSET), false);

    const hydrationDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration"
    );
    assert.ok(hydrationDescriptor);
    assert.equal(hydrationDescriptor.pattern.test(CURRENT_REMOTE_CONVERSATION_ASSET), false);
    assert.equal(hydrationDescriptor.pattern.test(LATEST_REMOTE_CONVERSATION_ASSET), false);
    assert.equal(hydrationDescriptor.pattern.test(UNIFIED_REMOTE_CONVERSATION_ASSET), true);
    assert.equal(hydrationDescriptor.pattern.test(OLD_APP_SERVER_MANAGER_ASSET), false);
    assert.equal(hydrationDescriptor.pattern.test("app-server-manager-signals-test.js"), false);
    assert.equal(hydrationDescriptor.pattern.test("remote-connections-settings-fixture.js"), false);
    assert.equal(hydrationDescriptor.pattern.test(CURRENT_PROJECTLESS_REMOTE_TASK_ASSET), false);

    const completedItemDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-mobile-completed-item-recovery"
    );
    assert.ok(completedItemDescriptor);
    assert.equal(completedItemDescriptor.pattern.test(UNIFIED_REMOTE_CONVERSATION_ASSET), true);
    assert.equal(completedItemDescriptor.pattern.test(OLD_APP_SERVER_MANAGER_ASSET), false);

    const terminalStatusDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-terminal-status-recovery"
    );
    assert.ok(terminalStatusDescriptor);
    assert.equal(terminalStatusDescriptor.pattern.test(UNIFIED_REMOTE_CONVERSATION_ASSET), true);
    assert.equal(terminalStatusDescriptor.pattern.test(OLD_APP_SERVER_MANAGER_ASSET), false);
    assert.equal(terminalStatusDescriptor.pattern.test("remote-connections-settings-fixture.js"), false);

    const loadGateDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-load-gate"
    );
    assert.ok(loadGateDescriptor);
    assert.equal(loadGateDescriptor.pattern.test(CURRENT_REMOTE_CONVERSATION_ASSET), false);
    assert.equal(loadGateDescriptor.pattern.test(LATEST_REMOTE_CONVERSATION_ASSET), false);
    assert.equal(loadGateDescriptor.pattern.test(UNIFIED_REMOTE_CONVERSATION_ASSET), true);
    assert.equal(loadGateDescriptor.pattern.test(OLD_REMOTE_CONTROL_GATE_ASSET), false);
    assert.equal(loadGateDescriptor.pattern.test("remote-connection-visibility-test.js"), false);
    assert.equal(loadGateDescriptor.pattern.test(CURRENT_PROJECTLESS_REMOTE_TASK_ASSET), false);

  });
});

test("Linux remote-control feature patch updates the device-key provider", () => {
  const source = syntheticMainBundle();
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.doesNotMatch(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(applyLinuxRemoteControlDeviceKeyPatch(patched), patched);
});

test("Linux remote-control device-key patch handles current minified aliases", () => {
  const source = syntheticCurrentMainBundle();
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.doesNotMatch(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(applyLinuxRemoteControlDeviceKeyPatch(patched), patched);
});

test("Linux remote-control device-key provider does not capture a function-local child-process alias", () => {
  const source = `function injectedFeature(){let __codexChild=require(\`node:child_process\`);return __codexChild}${syntheticMainBundle()}`;
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.match(patched, /require\(`node:child_process`\)\.spawn\(/);
  assert.doesNotMatch(patched, /__codexChild\.spawn\(/);
});

test("Linux remote-control device-key provider avoids upstream minified alias collisions", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-collision-"));
  try {
    const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticCryptoAliasCollisionMainBundle());
    assert.match(patched, /\(0,c\.generateKeyPairSync\)\(`/);
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
      __filename: path.join(configHome, "main.js"),
      module: { exports: {} },
      process: {
        env: { XDG_CONFIG_HOME: configHome },
        pid: process.pid,
        platform: "linux",
      },
      require,
      setTimeout,
    };

    vm.runInNewContext(`${patched};module.exports=pz({resourcesPath:null});`, context);
    const created = await context.module.exports.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");
    assert.match(created.keyId, /^[0-9a-f-]{36}$/u);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("Linux remote-control client revocation triggers local cleanup and re-enrollment", () => {
  const source = syntheticRecoverableErrorPredicateBundle();
  const patched = applyLinuxRemoteControlClientRevocationRecoveryPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /Remote-control client key material missing`\|\|e\.message===`Remote-control client has been revoked/);
  assert.match(patched, /Remote-control client has been revoked/);
  assert.equal(applyLinuxRemoteControlClientRevocationRecoveryPatch(patched), patched);
});

test("Linux remote-control client recovery handles bare missing key material errors", () => {
  const source = syntheticRecoverableErrorPredicateBundle();
  const patched = applyLinuxRemoteControlClientRevocationRecoveryPatch(source);

  assert.match(patched, /e\.message===`Remote-control client key material missing`/);
});

test("Linux remote mobile app-server launch enables remote control on the Desktop app-server", () => {
  const source = syntheticAppServerLaunchBundle();
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileAppServerArgs/);
  assert.match(
    patched,
    /process\.platform===`linux`\?\[`-c`,`features\.code_mode_host=true`,`app-server`,`--remote-control`,`--analytics-default-enabled`\]:\[`-c`,`features\.code_mode_host=true`,`app-server`,`--analytics-default-enabled`\]/,
  );
  assert.doesNotMatch(
    patched,
    /Wz=\[`-c`,`features\.code_mode_host=true`,`app-server`,`--analytics-default-enabled`\]/,
  );
  assert.match(patched, /Wz=codexLinuxRemoteMobileAppServerArgs\(\)/);
  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(patched), patched);
});

test("Linux remote mobile app-server launch keeps a leading use strict directive first", () => {
  const source = `"use strict";${syntheticAppServerLaunchBundle()}`;
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /^"use strict";function codexLinuxRemoteMobileAppServerArgs/);
  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(patched), patched);
});

test("Linux remote-control client revoke resets current setup state after the last client is removed", () => {
  const source = syntheticCurrentRevokeSetupResetBundle();
  const { result: patched, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlClientRevokeSetupResetPatch(source),
  );

  assert.notEqual(patched, source);
  assert.deepEqual(warnings, []);
  assert.match(patched, /codexLinuxRemoteControlResetMobileSetupAfterRevoke/);
  assert.equal(applyLinuxRemoteControlClientRevokeSetupResetPatch(patched), patched);

  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=ni({mode:\`manage\`,oneToOnePairingInAppEnabled:true});`, context);
  const { handler, query, store } = context.module.exports;
  query.data = [{ clientId: "desktop_1" }, { clientId: "phone_1" }];

  handler("phone_1");

  assert.deepEqual(query.data, [{ clientId: "desktop_1" }]);
  assert.equal(store.globalState["mobile-setup-completed"], false);
  assert.equal(query.invalidated, true);
});

test("Linux remote-control client revoke handles snake-case cached client identities", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=ni({mode:\`manage\`,oneToOnePairingInAppEnabled:true});`, context);
  const { handler, query, store } = context.module.exports;
  query.data = [{ client_id: "desktop_1" }, { client_id: "phone_1" }];

  handler("phone_1");

  assert.deepEqual(query.data, [{ client_id: "desktop_1" }]);
  assert.equal(store.globalState["mobile-setup-completed"], false);
});

test("Linux remote-control client revoke keeps current setup state while another client remains", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=ni({mode:\`manage\`,oneToOnePairingInAppEnabled:true});`, context);
  const { handler, query, store } = context.module.exports;
  query.data = [{ clientId: "desktop_1" }, { clientId: "phone_1" }, { clientId: "tablet_1" }];

  handler("phone_1");

  assert.deepEqual(query.data, [{ clientId: "desktop_1" }, { clientId: "tablet_1" }]);
  assert.equal(store.globalState["mobile-setup-completed"], true);
});

test("Linux remote-control client revoke resets current setup when the cache omits the local client", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=ni({mode:\`manage\`,oneToOnePairingInAppEnabled:true});`, context);
  const { handler, query, store } = context.module.exports;
  query.data = [{ clientId: "phone_1" }];

  handler("phone_1");

  assert.deepEqual(query.data, []);
  assert.equal(store.globalState["mobile-setup-completed"], false);
});

test("Linux remote-control client revoke preserves current setup when the cache is unknown", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticCurrentRevokeSetupResetBundle());
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=ni({mode:\`manage\`,oneToOnePairingInAppEnabled:true});`, context);
  const { handler, query, store } = context.module.exports;
  query.data = undefined;

  handler("phone_1");

  assert.equal(query.data, undefined);
  assert.equal(store.globalState["mobile-setup-completed"], true);
  assert.equal(query.invalidated, true);
});

test("Linux remote-control client revoke warns when a recognized bundle shape drifts", () => {
  const source = syntheticCurrentRevokeSetupResetBundle().replace(
    "onRevoked:e=>{k.setData(t=>t?.filter(t=>t.clientId!==e)),k.invalidate()}",
    "onRevoked:e=>{k.invalidate(),k.setData(t=>t?.filter(t=>t.clientId!==e))}",
  );
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlClientRevokeSetupResetPatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("revoke success handler")));
});

test("Linux remote-control client revoke rejects distant current-bundle anchors", () => {
  const source = syntheticCurrentRevokeSetupResetBundle().replace(
    "function ni(e)",
    `${"x".repeat(16_385)}function ni(e)`,
  );
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlClientRevokeSetupResetPatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("anchors are too far apart")));
});

test("Linux remote-control load gate enables remote-control environment loading", () => {
  const source = syntheticRemoteConnectionVisibilityBundle();
  const patched = applyLinuxRemoteControlLoadGatePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlLoadGateEnabled/);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return codexLinuxRemoteControlLoadGateEnabled\(\)\|\|c\(`1042620455`\)/);
  assert.equal(applyLinuxRemoteControlLoadGatePatch(patched), patched);
});

test("Linux remote-control feature sync forces remote_control and preserves remote_plugin on Linux", () => {
  const source = syntheticAppMainFeatureSyncBundle();
  const patched = applyLinuxRemoteControlFeatureSyncPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /\.remote_control=!0/);
  assert.match(patched, /n\[vI\]=t/);
  assert.match(patched, /codexLinuxRemoteControlFeatureSyncEnabled/);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)\?\(/);
  assert.match(patched, /\?\(codexLinuxRemoteControlFeatureSyncEnabled\(arguments\[2\],arguments\[3\]\)&&\(n\.remote_control=!0\),n\[vI\]=t,n\)/);
  assert.match(patched, /:\(n\[vI\]=t,n\)\}/);
  assert.equal(applyLinuxRemoteControlFeatureSyncPatch(patched), patched);
});

test("Linux remote-control feature sync does not advertise SSH hosts to mobile", async () => {
  const source = syntheticCurrentAppMainFeatureSyncBundle();
  const patched = applyLinuxRemoteControlFeatureSyncPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlFeatureSyncEnabled/);

  const calls = [];
  const context = {
    Promise,
    features: { apps: true, memories: false },
    navigator: { userAgent: "X11; Linux x86_64" },
    query: { invalidateQueries() {} },
    store: {
      get(key) {
        if (key === "local-host") return "local";
        if (key === "hosts") return ["local", "remote-ssh-discovered:devpod"];
        return undefined;
      },
    },
    dv: { default: () => false },
    ln(method, params) {
      calls.push({ method, params });
      return Promise.resolve();
    },
    xn(_store, hostId) {
      return { state: hostId === "remote-ssh-discovered:devpod" ? "connected" : "disconnected" };
    },
  };
  vm.runInNewContext(`${patched};yI();`, context);
  await Promise.resolve();

  const hostCalls = calls.filter((call) => call.method === "set-experimental-feature-enablement-for-host");
  assert.equal(hostCalls.length, 2);
  assert.equal(hostCalls[0].params.hostId, "local");
  assert.equal(hostCalls[0].params.enablement.remote_control, true);
  assert.equal(hostCalls[1].params.hostId, "remote-ssh-discovered:devpod");
  assert.equal(hostCalls[1].params.enablement.remote_control, undefined);
});

test("Linux remote-control visibility patch handles current settings bundle shape", () => {
  const source = syntheticCurrentVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux remote-control visibility patch handles current use-plugin gate shape", () => {
  const source = syntheticCurrentUsePluginVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux mobile setup copy does not refer to Mac-only Computer Use", () => {
  const source = syntheticMobileConnectedSettingsBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /apps on your Mac/);
  assert.match(patched, /apps on this Linux desktop/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux remote-control settings copy does not refer to this Mac", () => {
  const source = syntheticRemoteConnectionsSettingsCopyBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /defaultMessage:`[^`]*Mac/);
  assert.match(patched, /Control this Linux desktop/);
  assert.match(patched, /Devices that can control this Linux desktop/);
  assert.match(patched, /Devices you can control from this Linux desktop/);
  assert.match(patched, /SSH connections from this Linux desktop/);
  assert.match(patched, /Keep this Linux desktop awake/);
  assert.match(patched, /defaultMessage:`Linux`/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux mobile setup flow copy does not refer to Mac-only setup", () => {
  const source = syntheticMobileSetupFlowCopyBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /defaultMessage:`[^`]*Mac/);
  assert.match(patched, /Use your Linux apps while locked/);
  assert.match(patched, /Control Linux apps from your phone/);
  assert.match(patched, /apps on this Linux desktop/);
  assert.match(patched, /Connect your phone to this Linux desktop/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux remote-control settings UX patch keeps outbound tab visible and removes Mac copy", () => {
  const source = syntheticSettingsBundle();
  const patched = applyLinuxRemoteControlSettingsUxPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlSettingsTabs/);
  assert.match(patched, /codexLinuxRemoteControlSshInstallActions/);
  assert.match(patched, /function codexLinuxRemoteControlSettingsTabs\(e\)\{return e\}/);
  assert.doesNotMatch(patched, /e\.filter\(e=>e\.key!==`access-other-devices`\)/);
  assert.match(patched, /key:`access-other-devices`/);
  assert.match(patched, /Ce=Ae==null\?null:Re\(\{action:Ae\.action/);
  assert.match(patched, /Control this Linux desktop/);
  assert.match(patched, /Control this Linux desktop from your phone or other device/);
  assert.match(patched, /Add device to control this Linux desktop remotely/);
  assert.match(patched, /Devices that can control this Linux desktop/);
  assert.match(patched, /Keep Linux desktop awake/);
  assert.match(patched, /Allow this Linux desktop to be discovered and controlled/);
  assert.doesNotMatch(patched, /Control this Mac/);
  assert.doesNotMatch(patched, /this Mac/);
  assert.equal(applyLinuxRemoteControlSettingsUxPatch(patched), patched);
});

test("Linux remote-control SSH install sends the local Desktop app-server version for fresh installs", () => {
  const source = syntheticSshInstallSettingsBundle();
  const patched = applyLinuxRemoteControlSettingsUxPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlSshInstallRelease/);
  assert.match(patched, /codexLinuxRemoteControlSshInstallDefaultRelease/);
  assert.match(patched, /De\(`local`\)/);
  assert.match(patched, /release=codexLinuxRemoteControlSshInstallResolvedRelease/);
  assert.match(patched, /onClick:\(\)=>a\(n,codexLinuxRemoteControlSshInstallReleaseTarget\)/);

  const context = {
    $: { c: () => [] },
    __mutations: [],
    __states: [],
    globalThis: null,
    w: "Restart",
    ee: () => ({}),
    fn: () => null,
    dn: ({ error, state }) => ({
      isRestartAvailableNotice: false,
      statusError: error,
      statusState: state,
    }),
    Ne: () => ({
      action: {
        kind: "install-codex",
        label: "Install Codex",
        loadingLabel: "Installing",
      },
    }),
    oe: () => true,
    De: (hostId) =>
      hostId === "local"
        ? { appServerVersion: "0.136.0", error: null, installedCodexVersion: null, state: "connected" }
        : {
            appServerVersion: null,
            error: { code: "remote-codex-not-found" },
            installedCodexVersion: null,
            state: "error",
          },
    R: () => ({
      mutate(request, options) {
        context.__mutations.push(request);
        options.onSuccess({ state: "connected", error: null });
      },
    }),
  };
  context.globalThis = context;
  vm.runInNewContext(`${patched};let action=un({connection:{hostId:'remote-ssh:dev',displayName:'dev'},disabled:false,installCodexPending:false,onAuthenticate(){},onEdit(){},onInstallCodex:bt,onLogoutConnection(){},onRemove(){},onShowDetails(){},onToggleConnection(){}});action.onClick();`, context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.__mutations)), [{ hostId: "remote-ssh:dev", release: "0.136.0" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__states)), [{ hostId: "remote-ssh:dev", state: "connected", error: null }]);
  assert.equal(applyLinuxRemoteControlSettingsUxPatch(patched), patched);
});

test("Linux remote-control SSH install prefers update-required minRequiredVersion", () => {
  const patched = applyLinuxRemoteControlSettingsUxPatch(syntheticSshInstallSettingsBundle());
  const context = {
    $: { c: () => [] },
    __mutations: [],
    __states: [],
    globalThis: null,
    w: "Restart",
    ee: () => ({}),
    fn: () => null,
    dn: ({ error, state }) => ({
      isRestartAvailableNotice: false,
      statusError: error,
      statusState: state,
    }),
    Ne: () => ({
      action: {
        kind: "install-codex",
        label: "Update Codex",
        loadingLabel: "Updating",
      },
    }),
    oe: () => true,
    De: (hostId) =>
      hostId === "local"
        ? { appServerVersion: "0.136.0", error: null, installedCodexVersion: null, state: "connected" }
        : {
            appServerVersion: "0.130.0",
            error: { code: "update-required", currentVersion: "0.130.0", minRequiredVersion: "0.137.0" },
            installedCodexVersion: "0.130.0",
            state: "error",
          },
    R: () => ({
      mutate(request, options) {
        context.__mutations.push(request);
        options.onSuccess({ state: "connected", error: null });
      },
    }),
  };
  context.globalThis = context;
  vm.runInNewContext(`${patched};let action=un({connection:{hostId:'remote-ssh:dev',displayName:'dev'},disabled:false,installCodexPending:false,onAuthenticate(){},onEdit(){},onInstallCodex:bt,onLogoutConnection(){},onRemove(){},onShowDetails(){},onToggleConnection(){}});action.onClick();`, context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.__mutations)), [{ hostId: "remote-ssh:dev", release: "0.137.0" }]);
});

test("Linux remote-control settings UX patch handles current minified helper names", () => {
  const source = syntheticCurrentSettingsBundle();
  const patched = applyLinuxRemoteControlSettingsUxPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlSettingsTabs/);
  assert.match(patched, /function codexLinuxRemoteControlSettingsTabs\(e\)\{return e\}/);
  assert.match(patched, /tabs:codexLinuxRemoteControlSettingsTabs/);
  assert.match(patched, /key:`access-other-devices`/);
  assert.match(patched, /Control this Linux desktop/);
  assert.doesNotMatch(patched, /Control this Mac/);
  assert.equal(applyLinuxRemoteControlSettingsUxPatch(patched), patched);
});

test("Linux remote-connections refresh patch shortens polling and refreshes on resume signals", () => {
  const source = syntheticSettingsRefreshBundle();
  const patched = applyLinuxRemoteConnectionsRefreshPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /Qn=5e3/);
  assert.doesNotMatch(patched, /Qn=15e3/);
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

test("Linux remote-connections refresh patch handles current interval alias", () => {
  const source = syntheticCurrentSettingsRefreshBundle();
  const patched = applyLinuxRemoteConnectionsRefreshPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /Yn=5e3/);
  assert.doesNotMatch(patched, /Yn=15e3/);
  assert.match(patched, /codexLinuxRemoteConnectionsRefreshNow/);
  assert.match(patched, /document\.addEventListener\(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.match(patched, /window\.addEventListener\(`resume`,codexLinuxRemoteConnectionsRefreshNow\)/);
  assert.equal(applyLinuxRemoteConnectionsRefreshPatch(patched), patched);
});

test("Linux remote-connections refresh patch warns when upstream refresh needles drift", () => {
  const source = "const marker=`refresh-remote-connections`;window.setInterval(()=>marker,15e3);";
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteConnectionsRefreshPatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("refresh interval constant")));
  assert.ok(warnings.some((warning) => warning.includes("auto-refresh effect")));
});

test("Linux remote mobile Chrome bridge patch preserves Chrome when backends config narrows browser backends", () => {
  const source = syntheticChromeBrowserClientBundle();
  const patched = applyLinuxRemoteMobileChromeBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileBrowserBackends/);
  assert.match(patched, /function _y\(\)\{let e=Su\(dy\);return codexLinuxRemoteMobileBrowserBackends/);
  assert.equal(applyLinuxRemoteMobileChromeBridgePatch(patched), patched);

  const context = {
    BROWSER_USE_AVAILABLE_BACKENDS: ["iab"],
    module: { exports: {} },
    process: { platform: "linux" },
  };
  vm.runInNewContext(`${patched};module.exports=_y;`, context);
  assert.deepEqual([...context.module.exports()], ["chrome", "iab"]);
});

test("Linux remote mobile Chrome bridge patch handles current browser-client backend allowlist shape", () => {
  const source = syntheticCurrentChromeBrowserClientBundle();
  const patched = applyLinuxRemoteMobileChromeBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileBrowserBackends/);
  assert.match(patched, /function N_\(\)\{let e=nl\(y_\);return codexLinuxRemoteMobileBrowserBackends/);
  assert.equal(applyLinuxRemoteMobileChromeBridgePatch(patched), patched);

  const context = {
    BROWSER_USE_AVAILABLE_BACKENDS: ["iab"],
    module: { exports: {} },
    process: { platform: "linux" },
  };
  vm.runInNewContext(`${patched};module.exports=N_;`, context);
  assert.deepEqual([...context.module.exports()], ["chrome", "iab"]);
});

test("Linux remote mobile Chrome bridge patch no-ops on upstream browser preference routing", () => {
  const source = syntheticModernChromeBrowserClientBundle();
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteMobileChromeBridgePatch(source));

  assert.equal(result, source);
  assert.deepEqual(warnings, []);
});

test("Linux remote mobile Chrome bridge patch warns when browser-client needles drift", () => {
  const source = "var e2=[\"chrome\",\"iab\",\"cdp\"];function ly(e){return e2.some(t=>t===e)}";
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteMobileChromeBridgePatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("backend allowlist needles")));
});

test("Linux remote mobile conversation hydration patch handles current app-server signal shape", () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileThreadRuntimeStatus/);
  assert.match(patched, /h\?\.type===`active`\|\|h\?\.type===`idle`/);
  assert.match(patched, /codexLinuxRemoteMobileHydrateUnknownTurn/);
  assert.match(patched, /codexLinuxRemoteMobileNotificationQueue/);
  assert.match(patched, /codexLinuxRemoteMobileHydrationInFlight/);
  assert.match(patched, /n\.params\?\.turn\?\.threadId\?\?n\.params\?\.thread\?\.id/);
  assert.doesNotMatch(patched, /n\.params\?\.threadId/);
  assert.match(patched, /Skipping hydration for ambiguous turn\/started/);
  assert.match(patched, /codexLinuxRemoteMobilePendingNotifications\?\?=new Map/);
  assert.match(patched, /codexLinuxRemoteMobileInFlightHydrations\?\?=new Set/);
  assert.match(patched, /dedupedNotification:p>=0/);
  assert.match(patched, /this\.readThread\(d,\{includeTurns:!0\}\)/);
  assert.match(patched, /Hydrating conversation for turn\/started/);
  assert.match(patched, /Queueing turn\/started for hydrating conversation/);
  assert.match(patched, /this\.upsertConversationFromThread\(t\)/);
  assert.match(patched, /this\.codexLinuxRemoteMobileInFlightHydrations\?\.delete\(d\)/);
  assert.match(patched, /for\(let e of c\)this\.onNotification\(e\.method,e\.params\)/);
  assert.match(patched, /Queueing item\/started for hydrating conversation/);
  assert.match(patched, /Queueing item\/completed for hydrating conversation/);
  assert.match(patched, /Queueing turn\/completed for hydrating conversation/);
  assert.doesNotMatch(patched, /safe:\{[^}]*\b(?:conversationId|resolvedConversationId|turnId):/);
  assert.match(patched, /sensitive:\{conversationId:[^}]+resolvedConversationId:[^}]+turnId:/);
  assert.match(patched, /sensitive:\{conversationId:[^}]+error:/);
  assert.doesNotMatch(patched, /captureBrowserUseTurnRoute/);
  assert.doesNotMatch(patched, /releaseBrowserUseTurnRoute/);
  assert.equal(applyLinuxRemoteMobileConversationHydrationPatch(patched), patched);
});

test("Linux remote mobile hydration skips turn ids before reading threads", () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  manager.conversations = new Map();
  manager.readThread = () => {
    throw new Error("readThread should not be called for ambiguous turn ids");
  };

  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a" },
  });
});

test("Linux remote mobile hydration uses captured turn id normalizer helper", () => {
  const source = syntheticAppServerManagerSignalsBundle().replaceAll("I(", "J(");
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);

  assert.match(patched, /J\(l\)/);
  assert.match(patched, /J\(u\)/);
  assert.doesNotMatch(patched, /I\(l\)/);
  assert.doesNotMatch(patched, /I\(u\)/);

  const context = {
    module: { exports: {} },
    J: (value) => value,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  manager.conversations = new Map();
  manager.readThread = () => {
    throw new Error("readThread should not be called for ambiguous turn ids");
  };

  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a" },
  });
});

test("Linux remote mobile hydration ignores top-level thread ids without nested thread identity", () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  manager.conversations = new Map();
  manager.readThread = () => {
    throw new Error("readThread should not be called without nested thread identity");
  };

  manager.onNotification("turn/started", {
    threadId: "thread-a",
    turn: { id: "turn-a" },
  });
});

test("Linux remote mobile hydration uses nested real thread ids", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];
  const streamed = [];
  manager.conversations = new Map();
  manager.readThread = async (threadId) => {
    readThreadIds.push(threadId);
    return { thread: { id: threadId }, turns: [{ id: "turn-a" }] };
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };
  manager.markConversationStreaming = (threadId) => {
    streamed.push(threadId);
  };
  manager.updateConversationState = () => {};

  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a", threadId: "thread-a" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.deepEqual(streamed, ["thread-a"]);
});

test("Linux remote mobile hydration recovers when a completed turn is the first observed event", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];

  manager.conversations = new Map();
  manager.frameTextDeltaQueue = { drainBefore: () => false };
  manager.readThread = async (threadId) => {
    readThreadIds.push(threadId);
    return { thread: { id: threadId }, turns: [{ id: "turn-a" }] };
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };

  manager.onNotification("turn/completed", {
    threadId: "thread-a",
    turn: { id: "turn-a", threadId: "thread-a", status: "completed" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications?.has("thread-a"), false);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations?.has("thread-a"), false);
});

test("Linux remote mobile hydration recovers when a completed item is the first observed event", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];
  const updatedConversations = [];

  manager.conversations = new Map();
  manager.frameTextDeltaQueue = { drainBefore: () => false };
  manager.readThread = async (threadId) => {
    readThreadIds.push(threadId);
    return { thread: { id: threadId }, turns: [{ id: "turn-a" }] };
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };
  manager.updateConversationState = (threadId) => {
    updatedConversations.push(threadId);
  };

  manager.onNotification("item/completed", {
    item: { id: "item-a", type: "agentMessage" },
    threadId: "thread-a",
    turnId: "turn-a",
    completedAtMs: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.deepEqual(updatedConversations, ["thread-a"]);
  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications?.has("thread-a"), false);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations?.has("thread-a"), false);
});

test("Linux remote mobile hydration does not upsert summary-only conversations", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  let scheduledRetry = null;
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout(callback) {
      scheduledRetry = callback;
      return 1;
    },
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];
  const upsertedThreads = [];

  manager.conversations = new Map();
  manager.frameTextDeltaQueue = { drainBefore: () => false };
  manager.readThread = async (threadId) => {
    readThreadIds.push(threadId);
    return { thread: { id: threadId }, turns: [] };
  };
  manager.upsertConversationFromThread = (thread) => {
    upsertedThreads.push(thread.id);
    manager.conversations.set(thread.id, thread);
  };

  manager.onNotification("turn/completed", {
    threadId: "thread-a",
    turn: { id: "turn-a", threadId: "thread-a", status: "completed" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.deepEqual(upsertedThreads, []);
  assert.equal(manager.conversations.has("thread-a"), false);
  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications?.has("thread-a"), true);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations?.has("thread-a"), true);
  assert.equal(typeof scheduledRetry, "function");
});

test("Linux remote mobile hydration restarts when a pending queue exists without an in-flight read", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];
  const updatedConversations = [];
  let resolveRead;

  manager.conversations = new Map();
  manager.frameTextDeltaQueue = { drainBefore: () => false };
  manager.codexLinuxRemoteMobilePendingNotifications = new Map([
    [
      "thread-a",
      [
        {
          method: "turn/completed",
          params: { threadId: "thread-a", turn: { id: "turn-a", threadId: "thread-a" } },
        },
      ],
    ],
  ]);
  manager.readThread = (threadId) => {
    readThreadIds.push(threadId);
    return new Promise((resolve) => {
      resolveRead = () => resolve({ thread: { id: threadId }, turns: [{ id: "turn-a" }] });
    });
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };
  manager.updateConversationState = (threadId) => {
    updatedConversations.push(threadId);
  };

  manager.onNotification("item/completed", {
    item: { id: "item-a", type: "agentMessage" },
    threadId: "thread-a",
    turnId: "turn-a",
    completedAtMs: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications.get("thread-a").length, 2);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations.has("thread-a"), true);

  resolveRead();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications?.has("thread-a"), false);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations?.has("thread-a"), false);
  assert.deepEqual(updatedConversations, ["thread-a"]);
});

test("Linux remote mobile hydration dedupes concurrent unknown turn reads", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];
  const streamed = [];
  let resolveRead;

  manager.conversations = new Map();
  manager.readThread = (threadId) => {
    readThreadIds.push(threadId);
    return new Promise((resolve) => {
      resolveRead = () => resolve({ thread: { id: threadId }, turns: [{ id: "turn-a" }] });
    });
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };
  manager.markConversationStreaming = (threadId) => {
    streamed.push(threadId);
  };
  manager.updateConversationState = () => {};

  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a", threadId: "thread-a" },
  });
  manager.onNotification("turn/started", {
    threadId: "turn-b",
    turn: { id: "turn-b", threadId: "thread-a" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications.get("thread-a").length, 2);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations.has("thread-a"), true);

  resolveRead();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications.has("thread-a"), false);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations.has("thread-a"), false);
  assert.deepEqual(streamed, ["thread-a", "thread-a"]);
});

test("Linux remote mobile hydration coalesces duplicate pending turn starts", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  const readThreadIds = [];
  const streamed = [];
  let resolveRead;

  manager.conversations = new Map();
  manager.readThread = (threadId) => {
    readThreadIds.push(threadId);
    return new Promise((resolve) => {
      resolveRead = () => resolve({ thread: { id: threadId }, turns: [{ id: "turn-a" }] });
    });
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };
  manager.markConversationStreaming = (threadId) => {
    streamed.push(threadId);
  };
  manager.updateConversationState = () => {};

  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a", threadId: "thread-a", marker: "first" },
  });
  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a", threadId: "thread-a", marker: "latest" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(readThreadIds, ["thread-a"]);
  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications.get("thread-a").length, 1);
  assert.equal(
    manager.codexLinuxRemoteMobilePendingNotifications.get("thread-a")[0].params.turn.marker,
    "latest",
  );

  resolveRead();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications.has("thread-a"), false);
  assert.equal(manager.codexLinuxRemoteMobileInFlightHydrations.has("thread-a"), false);
  assert.deepEqual(streamed, ["thread-a"]);
});

test("Linux remote mobile hydration does not coalesce non-turn pending events", async () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);
  const context = {
    module: { exports: {} },
    I: (value) => value,
    setTimeout,
    z: { error() {}, warning() {} },
  };
  vm.runInNewContext(`${patched};module.exports=T;`, context);
  const manager = new context.module.exports();
  let resolveRead;

  manager.conversations = new Map();
  manager.readThread = (threadId) => {
    return new Promise((resolve) => {
      resolveRead = () => resolve({ thread: { id: threadId }, turns: [{ id: "turn-a" }] });
    });
  };
  manager.upsertConversationFromThread = (thread) => {
    manager.conversations.set(thread.id, thread);
  };
  manager.markConversationStreaming = () => {};
  manager.updateConversationState = () => {};

  manager.onNotification("turn/started", {
    threadId: "thread-a",
    turn: { threadId: "thread-a", marker: "missing-turn-id" },
  });
  manager.onNotification("item/started", {
    item: { id: "item-a" },
    threadId: "thread-a",
    turnId: "turn-a",
    startedAtMs: 1,
  });
  manager.onNotification("turn/started", {
    threadId: "turn-a",
    turn: { id: "turn-a", threadId: "thread-a", marker: "identified-turn" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const pending = manager.codexLinuxRemoteMobilePendingNotifications.get("thread-a");
  assert.equal(pending.length, 3);
  assert.deepEqual(
    Array.from(pending, (notification) => notification.method),
    ["turn/started", "item/started", "turn/started"],
  );

  resolveRead();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.codexLinuxRemoteMobilePendingNotifications.has("thread-a"), false);
});

test("Linux remote mobile conversation hydration patch retries transient and missing thread reads", () => {
  const source = syntheticAppServerManagerSignalsBundle();
  const patched = applyLinuxRemoteMobileConversationHydrationPatch(source);

  assert.match(patched, /Retrying hydration for turn\/started/);
  assert.match(patched, /Retrying hydration for missing conversation/);
  assert.match(patched, /Skipping hydration for missing conversation/);
  assert.match(patched, /if\(s<12\)/);
  assert.match(patched, /setTimeout\(\(\)=>o\(s\+1\),250\)/);
  assert.match(patched, /Failed to hydrate conversation for turn\/started/);
});

test("Linux remote mobile conversation hydration patch warns when only part of the queue drifted", () => {
  const source = syntheticAppServerManagerSignalsBundle().replace(
    "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}",
    "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{id:r},sensitive:{}});break}",
  );
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteMobileConversationHydrationPatch(source));

  assert.notEqual(result, source);
  assert.match(result, /codexLinuxRemoteMobileHydrateUnknownTurn/);
  assert.ok(warnings.some((warning) => warning.includes("unknown turn/completed needle")));
});

test("remote mobile completed-item recovery restores a missing started item", () => {
  const source = syntheticCompletedItemRecoveryBundle();
  const patched = applyLinuxRemoteMobileCompletedItemRecoveryPatch(source);

  assert.notEqual(patched, source);
  assert.equal(applyLinuxRemoteMobileCompletedItemRecoveryPatch(patched), patched);
  assert.match(patched, /codexLinuxCompletedItemExists=n\.items\.some\(e=>e\.id===s\.id\)/);
  assert.match(
    patched,
    /if\(e\.type!==`subAgentActivity`&&codexLinuxCompletedItemExists&&!LB\(n,e\.id,e\.type\)\)return;bP\(n,s\)/,
  );

  const context = {};
  vm.runInNewContext(
    [
      "let errors=[];",
      "var $={error:(message,details)=>errors.push({message,details})};",
      "function qf(e){return e}",
      "function fI(e,t){return e.turns.find(t)}",
      "function gI(){throw Error(`unexpected userMessage path`)}",
      "function uI(){throw Error(`unexpected null turn path`)}",
      "function aR(){}",
      "function yV(){return true}",
      "function Jtt({item:e}){return {type:e.type,id:e.id,text:e.text??null}}",
      "function FF(e){return e}",
      "function bP(e,t){let n=e.items.findIndex(e=>e.id===t.id);n>=0?e.items[n]=t:e.items.push(t)}",
      "function LB(e,t,n){let r=e.items.find(e=>e.id===t&&e.type===n);if(r)return r;$.error(`Item not found in turn state`,{safe:{itemId:t},sensitive:{}});return null}",
      "function Put(){return null}",
      patched,
      "function run(items){errors=[];let turn={turnId:`turn-1`,items:items.map(e=>({...e}))},conversation={turns:[turn]},manager=new U;manager.frameTextDeltaQueue={drainBefore:()=>false};manager.conversations=new Map([[`thread-1`,{}]]);manager.threadStore={threadsById:new Map};manager.hydrateCollabThreads=()=>{};manager.updateConversationState=(id,fn)=>fn(conversation);manager.onNotification(`item/completed`,{item:{type:`agentMessage`,id:`assistant-1`,text:`done`},threadId:`thread-1`,turnId:`turn-1`,completedAtMs:100});return {items:turn.items,errors}}",
      "result={missing:run([]),existing:run([{type:`agentMessage`,id:`assistant-1`,text:`old`}]),wrongType:run([{type:`plan`,id:`assistant-1`,text:`old`}])};",
    ].join(";"),
    context,
  );
  const behavior = JSON.parse(JSON.stringify(context.result));
  assert.deepEqual(behavior.missing.items, [
    { type: "agentMessage", id: "assistant-1", text: "done" },
  ]);
  assert.deepEqual(behavior.existing.items, [
    { type: "agentMessage", id: "assistant-1", text: "done" },
  ]);
  assert.deepEqual(behavior.wrongType.items, [
    { type: "plan", id: "assistant-1", text: "old" },
  ]);
  assert.equal(behavior.missing.errors.length, 0);
  assert.equal(behavior.existing.errors.length, 0);
  assert.equal(behavior.wrongType.errors.length, 1);
});

test("Linux remote-control status guard skips slow remote SSH status reads", async () => {
  const source = syntheticAppServerManagerStatusBundle();
  const patched = applyLinuxRemoteControlStatusReadGuardPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlShouldReadStatus/);
  assert.equal(applyLinuxRemoteControlStatusReadGuardPatch(patched), patched);

  const context = {
    module: { exports: {} },
    navigator: { userAgent: "X11; Linux x86_64" },
    Promise,
    z: { error() {} },
  };
  vm.runInNewContext(`${patched};module.exports={SO,bO};`, context);
  const { SO } = context.module.exports;
  const generations = new Map();
  const values = new Map();
  const store = {
    bump(hostId) {
      const next = (generations.get(hostId) ?? 0) + 1;
      generations.set(hostId, next);
      return next;
    },
    current(hostId) {
      return generations.get(hostId);
    },
    get(_atom, hostId) {
      return values.get(hostId) ?? null;
    },
    set(_atom, hostId, value) {
      values.set(hostId, value);
    },
  };

  let remoteRequests = 0;
  SO(store, {
    getHostId: () => "remote-ssh-discovered:dev",
    addNotificationCallback() {},
    sendRequest() {
      remoteRequests += 1;
      return Promise.resolve({ status: "enabled" });
    },
  });
  assert.equal(remoteRequests, 0);
  const disabledStatus = values.get("remote-ssh-discovered:dev");
  assert.equal(disabledStatus.status, "disabled");
  assert.equal(disabledStatus.available, false);
  assert.equal(disabledStatus.accessRequired, false);

  let localRequests = 0;
  SO(store, {
    getHostId: () => "local",
    addNotificationCallback() {},
    sendRequest(method) {
      localRequests += 1;
      assert.equal(method, "remoteControl/status/read");
      return Promise.resolve({ status: "enabled" });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(localRequests, 1);
  assert.equal(values.get("local").status, "enabled");
});

test("Linux remote-control status guard skips remote-control environment status reads", () => {
  const source = syntheticAppServerManagerStatusBundle();
  const patched = applyLinuxRemoteControlStatusReadGuardPatch(source);

  assert.match(patched, /startsWith\(`remote-control:`\)/);

  const context = {
    module: { exports: {} },
    navigator: { userAgent: "X11; Linux x86_64" },
  };
  vm.runInNewContext(`${patched};module.exports={codexLinuxRemoteControlShouldReadStatus};`, context);
  const { codexLinuxRemoteControlShouldReadStatus } = context.module.exports;

  assert.equal(codexLinuxRemoteControlShouldReadStatus("remote-control:env_test"), false);
  assert.equal(codexLinuxRemoteControlShouldReadStatus("remote-ssh-discovered:dev"), false);
  assert.equal(codexLinuxRemoteControlShouldReadStatus("local"), true);
});

test("Linux remote terminal status recovery treats stale waiting input as idle", () => {
  const source =
    "function LQt({hasInProgressSideChat:e,isResponseInProgress:t,latestTurnHasSystemError:n,resumeState:r,threadRuntimeStatus:i}){return e?`loading`:i?.type===`systemError`?`error`:i?.type===`active`?`loading`:r===`needs_resume`?`idle`:n?`error`:t===!0?`loading`:`idle`}function RQt({pendingRequestType:e,requests:t,resumeState:n,threadRuntimeStatus:r}){return t==null||n==null?null:n===`needs_resume`?r?.type===`active`&&r.activeFlags.includes(`waitingOnApproval`)&&yi(t)?`approval`:r?.type===`active`&&r.activeFlags.includes(`waitingOnUserInput`)?`response`:null:Zr(e)?`approval`:e===`userInput`?`response`:null}var IQt,AQt,OQt=e((()=>{G(),Lr(),Tt(),Ni(),kt(),IQt=s(V,(e,{get:t})=>{let n=t(rr,e);return LQt({hasInProgressSideChat:t(Qw,e),isResponseInProgress:t(ki,e),resumeState:t(si,e)??(n==null?null:`needs_resume`),threadRuntimeStatus:t(Or,e)??n?.threadRuntimeStatus??null,latestTurnHasSystemError:t(Ui,e)===!0})}),AQt=s(V,(e,{get:t})=>RQt({pendingRequestType:t(wr,e)?.type??null,requests:t(fi,e),resumeState:t(si,e),threadRuntimeStatus:t(Or,e)}))}))";

  const patched = applyPatchTwice(applyLinuxRemoteTerminalStatusRecoveryPatch, source);

  assert.match(patched, /codexLinuxRemoteTerminalStatusActive=i\?\.type===`active`/);
  assert.match(patched, /codexLinuxRemoteTerminalStatusWaitingOnUserInput/);
  assert.match(patched, /function codexLinuxRemoteHasUserInputRequest/);
  assert.match(
    patched,
    /hasUserInputRequest:codexLinuxRemoteHasUserInputRequest\(t\(fi,e\)\)/,
  );
  assert.doesNotMatch(
    patched,
    /i\?\.type===`active`\?`loading`:r===`needs_resume`/,
  );

  const context = {};
  const runtimeSource = patched.slice(0, patched.indexOf("var IQt"));
  vm.runInNewContext(
    `function yi(e){return Array.isArray(e)&&e.some(e=>e.method===\`item/commandExecution/requestApproval\`||e.method===\`item/fileChange/requestApproval\`||e.method===\`item/permissions/requestApproval\`)}
     function Zr(e){return e===\`approval\`}
     ${runtimeSource};result={
      stale:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`,activeFlags:[]}}),
      nullStatus:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:null}),
      streaming:LQt({hasInProgressSideChat:false,isResponseInProgress:true,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`,activeFlags:[]}}),
      waitingStale:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`,activeFlags:[\`waitingOnUserInput\`]},hasUserInputRequest:false}),
      waitingWithRequest:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`,activeFlags:[\`waitingOnUserInput\`]},hasUserInputRequest:true}),
      waitingWithoutWiredRequest:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`,activeFlags:[\`waitingOnUserInput\`]}}),
      unknownShape:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`}}),
      sideChat:LQt({hasInProgressSideChat:true,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`active\`,activeFlags:[]}}),
      systemError:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:null,threadRuntimeStatus:{type:\`systemError\`}}),
      turnError:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:true,resumeState:null,threadRuntimeStatus:{type:\`idle\`}}),
      needsResume:LQt({hasInProgressSideChat:false,isResponseInProgress:false,latestTurnHasSystemError:false,resumeState:\`needs_resume\`,threadRuntimeStatus:{type:\`idle\`}}),
      pendingStale:RQt({pendingRequestType:null,requests:[],resumeState:\`needs_resume\`,threadRuntimeStatus:{type:\`active\`,activeFlags:[\`waitingOnUserInput\`]}}),
      pendingWithRequest:RQt({pendingRequestType:null,requests:[{method:\`item/tool/requestUserInput\`}],resumeState:\`needs_resume\`,threadRuntimeStatus:{type:\`active\`,activeFlags:[\`waitingOnUserInput\`]}}),
      pendingMalformedActive:RQt({pendingRequestType:null,requests:[{method:\`item/tool/requestUserInput\`}],resumeState:\`needs_resume\`,threadRuntimeStatus:{type:\`active\`}}),
      pendingApproval:RQt({pendingRequestType:null,requests:[{method:\`item/commandExecution/requestApproval\`}],resumeState:\`needs_resume\`,threadRuntimeStatus:{type:\`active\`,activeFlags:[\`waitingOnApproval\`]}})
    };`,
    context,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
    stale: "idle",
    nullStatus: "idle",
    streaming: "loading",
    waitingStale: "idle",
    waitingWithRequest: "loading",
    waitingWithoutWiredRequest: "loading",
    unknownShape: "loading",
    sideChat: "loading",
    systemError: "error",
    turnError: "error",
    needsResume: "idle",
    pendingStale: null,
    pendingWithRequest: "response",
    pendingMalformedActive: null,
    pendingApproval: "approval",
  });
});

test("Linux remote terminal status recovery rejects partial current-bundle drift", () => {
  const source = syntheticRemoteTerminalStatusBundle();
  const driftedSources = [
    source.replace("threadRuntimeStatus:i}){return", "threadRuntimeStatus:i,extra:o}){return"),
    source.replace("pendingRequestType:e,requests:t", "pendingRequestType:e,extra:o,requests:t"),
    source.replace("return LQt({hasInProgressSideChat:", "return LQt({extra:!0,hasInProgressSideChat:"),
  ];

  for (const driftedSource of driftedSources) {
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

test("Linux remote terminal status recovery ignores unrelated matching chunks", () => {
  const source = "const remoteMobileConversationChunk={threadRuntimeStatus:null};";
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteTerminalStatusRecoveryPatch(source),
  );

  assert.equal(result, source);
  assert.deepEqual(warnings, []);
});

test("Linux remote terminal status recovery escapes current minified function aliases", () => {
  const source = syntheticRemoteTerminalStatusBundle().split("LQt").join("$yn");
  const patched = applyLinuxRemoteTerminalStatusRecoveryPatch(source);

  assert.notEqual(patched, source);
  assert.match(
    patched,
    /hasUserInputRequest:codexLinuxRemoteHasUserInputRequest\(t\(fi,e\)\)/,
  );
});

test("Linux remote-control status wait supports the current 26.707 app bundle", () => {
  const source = syntheticCurrentStatusWaitBundle();
  const patched = applyLinuxRemoteControlStatusWaitPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlStatusWaitMs/);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)\?3e4:5e3/);
  assert.equal(applyLinuxRemoteControlStatusWaitPatch(patched), patched);
});

test("Linux remote-control status wait ignores matching atom initializer decoys", () => {
  const decoy =
    "var D,A,B,C;D=5e3,A=va(X,e=>null),B=va(X,e=>!1),C=ya(X,(e,{get:t})=>t(A,e));";
  const patched = applyLinuxRemoteControlStatusWaitPatch(decoy + syntheticCurrentStatusWaitBundle());

  assert.match(patched, /D=5e3,A=va\(X,e=>null\)/);
  assert.match(
    patched,
    /F5t=typeof navigator!=`undefined`&&navigator\.userAgent\.includes\(`Linux`\)\?3e4:5e3/,
  );
});

test("Linux remote-control settings UX patch warns when SSH release handling drifts after partial patching", () => {
  const source = (syntheticSettingsBundle() + syntheticSshInstallSettingsBundle()).replace(
    "installedCodexVersion:h",
    "installedVersion:h",
  );
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlSettingsUxPatch(source));

  assert.notEqual(result, source);
  assert.match(result, /codexLinuxRemoteControlSettingsTabs/);
  assert.ok(warnings.some((warning) => warning.includes("SSH install release needles")));
});

test("remote mobile feature patch report records feature metadata and partial warnings", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-report-"));
    try {
      const buildDir = path.join(tempApp, ".vite", "build");
      const assetsDir = path.join(tempApp, "webview", "assets");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "main.js"), syntheticCurrentMainBundle());
      fs.writeFileSync(path.join(buildDir, "src-test.js"), syntheticAppServerLaunchBundle());
      fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));
      fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");
      fs.writeFileSync(
        path.join(assetsDir, UNIFIED_REMOTE_CONVERSATION_ASSET),
        syntheticAppServerManagerSignalsBundle() +
          syntheticAppServerManagerStatusBundle() +
          syntheticCompletedItemRecoveryBundle() +
          syntheticRemoteTerminalStatusBundle(),
      );
      fs.writeFileSync(
        path.join(assetsDir, CURRENT_REMOTE_CONNECTIONS_VISIBILITY_ASSET),
        syntheticRemoteConnectionVisibilityBundle(),
      );
      fs.writeFileSync(
        path.join(assetsDir, CURRENT_APP_MAIN_PAGE_ASSET),
        syntheticAppMainFeatureSyncBundle() + syntheticAppMainEnablementBridgeBundle(),
      );
      fs.writeFileSync(
        path.join(assetsDir, CURRENT_REMOTE_CONVERSATION_STATUS_ASSET),
        syntheticAppMainActiveStatusBundle(),
      );
      fs.writeFileSync(
        path.join(assetsDir, "remote-connections-settings-test.js"),
        (syntheticSettingsBundle() + syntheticSshInstallSettingsBundle()).replace(
          "installedCodexVersion:h",
          "installedVersion:h",
        ),
      );
      fs.writeFileSync(
        path.join(assetsDir, OLD_APP_SERVER_MANAGER_ASSET),
        syntheticAppServerManagerSignalsBundle(),
      );
      fs.writeFileSync(
        path.join(assetsDir, "app-server-manager-signals-test.js"),
        syntheticAppServerManagerSignalsBundle().replace(
          "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}",
          "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{id:r},sensitive:{}});break}",
        ),
      );
      fs.writeFileSync(path.join(assetsDir, "codex-mobile-setup-flow-test.js"), syntheticMobileSetupFlowCopyBundle());
      fs.writeFileSync(path.join(assetsDir, "use-codex-mobile-connected-settings-test.js"), syntheticMobileConnectedSettingsBundle());

      const report = createPatchReport();
      withFeatureRootEnv(root, () => patchExtractedApp(tempApp, { report }));

      assert.deepEqual(report.enabledFeatures, ["remote-mobile-control"]);
      const settingsPatch = report.patches.find(
        (patch) => patch.name === "feature:remote-mobile-control:linux-remote-control-settings-ux",
      );
      assert.equal(settingsPatch.sourceKind, "feature");
      assert.equal(settingsPatch.featureId, "remote-mobile-control");
      assert.equal(settingsPatch.status, "applied-with-warnings");
      assert.ok(settingsPatch.warnings.some((warning) => warning.includes("SSH install release needles")));

      assert.equal(
        report.patches.some((patch) => patch.name === "linux-app-server-conversation-hydration"),
        false,
      );

      const featureHydrationPatch = report.patches.find(
        (patch) => patch.name === "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration",
      );
      assert.equal(featureHydrationPatch.sourceKind, "feature");
      assert.equal(featureHydrationPatch.status, "applied");

      const completedItemPatch = report.patches.find(
        (patch) => patch.name === "feature:remote-mobile-control:linux-remote-mobile-completed-item-recovery",
      );
      assert.equal(completedItemPatch.sourceKind, "feature");
      assert.equal(completedItemPatch.featureId, "remote-mobile-control");
      assert.equal(completedItemPatch.status, "applied");
      assert.equal(
        report.patches.some((patch) => patch.name === "linux-completed-item-recovery"),
        false,
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
  vm.runInNewContext(`${patched};module.exports=pS;`, context);
  const status = context.module.exports;

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

test("Linux remote-control enablement bridge loads remote-control clients on Linux", async () => {
  const source = syntheticAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlEnablementBridge/);
  assert.equal(applyLinuxRemoteControlEnablementBridgePatch(patched), patched);

  const calls = [];
  const context = {
    DF: "[remote-connections/slingshot-gate-bridge]",
    navigator: { userAgent: "X11; Linux x86_64" },
    q: { warning() {} },
    Q: { useEffect(callback) { callback(); } },
    sc: () => ({ checkGate: () => false, isLoading: false }),
    Z: { c: () => [] },
    $o: (method, { params }) => {
      calls.push({ method, params });
      return Promise.resolve();
    },
  };
  vm.runInNewContext(`${patched};OF();`, context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "set-remote-control-connections-enabled");
  assert.equal(calls[0].params.enabled, true);
});

test("Linux remote-control enablement bridge rejects distant anchors", () => {
  const source = [
    "var DF=`[remote-connections/slingshot-gate-bridge]`;",
    "x".repeat(4_501),
    "function OF(){return $o(`set-remote-control-connections-enabled`,{params:{enabled:true}})}",
  ].join("");
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlEnablementBridgePatch(source),
  );

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("anchors are too far apart")));
});

test("Linux remote-control enablement bridge omits params for current host toggle handler", async () => {
  const source = syntheticCurrentAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlEnableForHostParams/);
  assert.doesNotMatch(patched, /remoteControl\/disable`,null/);
  assert.equal(applyLinuxRemoteControlEnablementBridgePatch(patched), patched);

  const calls = [];
  const context = {
    pU: (handler) => handler,
    host: {
      sendRequest(method, params) {
        calls.push({ method, params });
        return Promise.resolve({ status: "enabled" });
      },
    },
  };
  await vm.runInNewContext(`${patched};handlers["set-remote-control-enabled-for-host"](host,{enabled:true});`, context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "remoteControl/enable");
  assert.equal(calls[0].params, undefined);
});

test("Linux remote-control host toggle params patch handles automations app-main bundle", async () => {
  const source =
    "var handlers={\"set-remote-control-enabled-for-host\":Q7((e,{enabled:t})=>e.sendRequest(t?`remoteControl/enable`:`remoteControl/disable`,null)),\"start-remote-control-pairing-for-host\":Q7((e,{manualCode:t})=>e.sendRequest(`remoteControl/pairing/start`,{manualCode:t}))};";
  const patched = applyLinuxRemoteControlEnableForHostParamsPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlEnableForHostParams/);
  assert.doesNotMatch(patched, /remoteControl\/disable`,null/);
  assert.equal(applyLinuxRemoteControlEnableForHostParamsPatch(patched), patched);

  const calls = [];
  const context = {
    Q7: (handler) => handler,
    host: {
      sendRequest(method, params) {
        calls.push({ method, params });
        return Promise.resolve({ status: "enabled" });
      },
    },
  };
  await vm.runInNewContext(`${patched};handlers["set-remote-control-enabled-for-host"](host,{enabled:true});`, context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "remoteControl/enable");
  assert.equal(calls[0].params, undefined);
});

test("Linux remote-control enablement bridge warns when host toggle params needle drifts", () => {
  const source =
    "var handlers={\"set-remote-control-enabled-for-host\":pU((e,{enabled:t})=>e.sendRequest((t?`remoteControl/enable`:`remoteControl/disable`),null))};";
  const { result, warnings } = captureWarnings(() => applyLinuxRemoteControlEnablementBridgePatch(source));

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("enable-for-host params needle")));
});

test("Linux remote-control enablement bridge auto-connects only this Desktop host", async () => {
  const source = syntheticAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

  assert.doesNotMatch(patched, /safe:\{[^}]*\bhostId:/);
  assert.match(patched, /sensitive:\{hostId:[^}]+error:/);

  const calls = [];
  const context = {
    DF: "[remote-connections/slingshot-gate-bridge]",
    navigator: { userAgent: "X11; Linux x86_64" },
    Promise,
    q: { warning() {} },
    Q: {
      useEffect(callback) {
        callback();
      },
    },
    sc: () => ({ checkGate: () => false, isLoading: false }),
    Z: { c: () => [] },
    $o: (method, { params }) => {
      calls.push({ method, params });
      if (method === "set-remote-control-connections-enabled") {
        return Promise.resolve({
          remoteControlConnections: [
            { hostId: "remote-control:env_local", installationId: "install_local" },
            { hostId: "remote-control:env_stale", installationId: "install_stale" },
          ],
        });
      }
      if (method === "get-global-state") {
        return Promise.resolve({ value: "install_local" });
      }
      return Promise.resolve({});
    },
  };
  vm.runInNewContext(`${patched};OF();`, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 4);
  assert.equal(calls[0].method, "set-remote-control-connections-enabled");
  assert.equal(calls[0].params.enabled, true);
  assert.equal(calls[1].method, "get-global-state");
  assert.equal(calls[1].params.key, "electron-local-remote-control-installation-id");
  assert.equal(calls[2].method, "set-remote-connection-auto-connect");
  assert.equal(calls[2].params.hostId, "remote-control:env_local");
  assert.equal(calls[2].params.autoConnect, true);
  assert.equal(calls[3].method, "set-remote-connection-auto-connect");
  assert.equal(calls[3].params.hostId, "remote-control:env_stale");
  assert.equal(calls[3].params.autoConnect, false);
});

test("patched Linux device-key provider can create, sign with, and delete a key", async () => {
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
      __filename: path.join(configHome, "main.js"),
      module: { exports: {} },
      process: {
        env: { XDG_CONFIG_HOME: configHome },
        pid: process.pid,
        platform: "linux",
      },
      require,
      setTimeout,
    };

    vm.runInNewContext(`${patched};module.exports=wV({resourcesPath:null});`, context);
    const client = context.module.exports;
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");
    assert.match(created.publicKeySpkiDerBase64, /^[A-Za-z0-9+/]+=*$/);

    const readBack = await client.getDeviceKeyPublic(created.keyId);
    assert.deepEqual(readBack, created);

    const signature = await client.signDeviceKey(created.keyId, {
      type: "remoteControlClientEnrollment",
      nonce: "test",
    });
    assert.equal(signature.algorithm, "ecdsa_p256_sha256");
    assert.match(signature.signatureDerBase64, /^[A-Za-z0-9+/]+=*$/);
    assert.match(signature.signedPayloadBase64, /^[A-Za-z0-9+/]+=*$/);

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

test("Linux device-key store serializes concurrent updates", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-concurrency-"));
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    const created = await Promise.all(
      Array.from({ length: 8 }, () => client.createDeviceKey("allow_os_protected_nonextractable")),
    );
    const { directory, lock, store } = remoteControlKeyStorePaths(configHome);
    const persisted = JSON.parse(fs.readFileSync(store, "utf8"));

    assert.equal(persisted.version, 1);
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

test("Linux device-key store contends on its validated lock file", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-lock-"));
  let holder;
  try {
    const client = createPatchedDeviceKeyClient(configHome);
    await client.createDeviceKey("test");
    const { lock } = remoteControlKeyStorePaths(configHome);
    holder = spawn("flock", ["-x", lock, "sh", "-c", "printf 'ready\\n'; sleep 0.25"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    assert.ok(Date.now() - startedAt >= 150, "key update must wait for the existing file lock");
  } finally {
    holder?.kill();
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
    assert.equal(migrated.version, 1);
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
    persisted.version = 2;
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
      assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);

      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), source);
        fs.writeFileSync(path.join(buildDir, "workspace-root-drop-handler-test.js"), syntheticAppServerLaunchBundle());
        fs.writeFileSync(
          path.join(assetsDir, UNIFIED_REMOTE_CONVERSATION_ASSET),
          syntheticRemoteConnectionVisibilityBundle() +
            syntheticAppServerManagerSignalsBundle() +
            syntheticAppServerManagerStatusBundle() +
            syntheticCurrentStatusWaitBundle() +
            syntheticCompletedItemRecoveryBundle() +
            syntheticRemoteTerminalStatusBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, CURRENT_REMOTE_CONNECTIONS_VISIBILITY_ASSET),
          syntheticCurrentUsePluginVisibilityBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          syntheticSettingsBundle() +
            syntheticRemoteConnectionsSettingsCopyBundle() +
            syntheticSettingsRefreshBundle() +
            syntheticCurrentRevokeSetupResetBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "codex-mobile-setup-flow-test.js"),
          syntheticMobileSetupFlowCopyBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "use-codex-mobile-connected-settings-test.js"),
          syntheticMobileConnectedSettingsBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, OLD_APP_SERVER_MANAGER_ASSET),
          syntheticAppServerManagerSignalsBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "app-server-manager-signals-test.js"),
          syntheticAppServerManagerSignalsBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, CURRENT_APP_MAIN_PAGE_ASSET),
          syntheticAppMainFeatureSyncBundle() +
            syntheticAppMainEnablementBridgeBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, CURRENT_REMOTE_CONVERSATION_STATUS_ASSET),
          syntheticAppMainActiveStatusBundle(),
        );
        const report = createPatchReport();
        patchExtractedApp(tempApp, { report });

        const patchedFile = fs.readFileSync(path.join(buildDir, "main.js"), "utf8");
        const patchedAppServerLaunchFile = fs.readFileSync(
          path.join(buildDir, "workspace-root-drop-handler-test.js"),
          "utf8",
        );
        const patchedVisibilityFile = fs.readFileSync(
          path.join(assetsDir, CURRENT_REMOTE_CONNECTIONS_VISIBILITY_ASSET),
          "utf8",
        );
        const patchedRemoteConnectionVisibilityFile = fs.readFileSync(
          path.join(assetsDir, UNIFIED_REMOTE_CONVERSATION_ASSET),
          "utf8",
        );
        const patchedAppMainFile = fs.readFileSync(
          path.join(assetsDir, CURRENT_APP_MAIN_PAGE_ASSET),
          "utf8",
        );
        const patchedActiveStatusFile = fs.readFileSync(
          path.join(assetsDir, CURRENT_REMOTE_CONVERSATION_STATUS_ASSET),
          "utf8",
        );
        const patchedRemoteConnectionsSettingsFile = fs.readFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          "utf8",
        );
        const patchedMobileSetupFlowFile = fs.readFileSync(
          path.join(assetsDir, "codex-mobile-setup-flow-test.js"),
          "utf8",
        );
        const patchedMobileConnectedSettingsFile = fs.readFileSync(
          path.join(assetsDir, "use-codex-mobile-connected-settings-test.js"),
          "utf8",
        );
        const patchedSignalsFile = fs.readFileSync(
          path.join(assetsDir, UNIFIED_REMOTE_CONVERSATION_ASSET),
          "utf8",
        );
        const patchedStatusFile = fs.readFileSync(
          path.join(assetsDir, UNIFIED_REMOTE_CONVERSATION_ASSET),
          "utf8",
        );
        assert.match(patchedFile, /codexLinuxRemoteControlDeviceKeyClient/);
        assert.match(patchedFile, /n\.kind===`local`&&process\.platform!==`linux`/);
        assert.match(patchedAppServerLaunchFile, /codexLinuxRemoteMobileAppServerArgs/);
        assert.match(patchedAppServerLaunchFile, /`--remote-control`/);
        assert.match(patchedRemoteConnectionVisibilityFile, /codexLinuxRemoteControlLoadGateEnabled/);
        assert.match(patchedAppMainFile, /\.remote_control=!0/);
        assert.match(patchedVisibilityFile, /navigator\.userAgent\.includes\(`Linux`\)/);
        assert.match(patchedRemoteConnectionsSettingsFile, /codexLinuxRemoteControlSettingsTabs/);
        assert.match(patchedRemoteConnectionsSettingsFile, /codexLinuxRemoteControlResetMobileSetupAfterRevoke/);
        assert.match(patchedRemoteConnectionsSettingsFile, /codexLinuxRemoteConnectionsRefreshNow/);
        assert.match(patchedRemoteConnectionsSettingsFile, /Qn=5e3/);
        assert.match(patchedRemoteConnectionsSettingsFile, /Control this Linux desktop/);
        assert.match(patchedRemoteConnectionsSettingsFile, /SSH connections from this Linux desktop/);
        assert.match(patchedMobileSetupFlowFile, /Connect your phone to this Linux desktop/);
        assert.match(patchedMobileConnectedSettingsFile, /apps on this Linux desktop/);
        assert.match(patchedSignalsFile, /codexLinuxRemoteMobileHydrateUnknownTurn/);
        assert.match(patchedSignalsFile, /codexLinuxRemoteMobileThreadRuntimeStatus/);
        assert.match(patchedSignalsFile, /codexLinuxCompletedItemExists=/);
        assert.match(patchedStatusFile, /codexLinuxRemoteControlShouldReadStatus/);
        assert.match(patchedStatusFile, /codexLinuxRemoteControlStatusWaitMs/);
        assert.match(patchedAppMainFile, /codexLinuxRemoteControlEnablementBridge/);
        assert.match(patchedActiveStatusFile, /codexLinuxRemoteMobileActiveStatus/);
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-device-key" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "linux-remote-control-config-preservation" &&
            patch.status === "applied",
          ),
        );
        assert.equal(
          report.patches.some(
            (patch) => patch.name === "feature:remote-mobile-control:linux-remote-control-preserve-config",
          ),
          false,
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-app-server-remote-control" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-load-gate" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-feature-sync" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-visibility" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-copy" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-settings-ux" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-client-revoke-setup-reset" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-connections-refresh" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          !report.patches.some(
            (patch) => patch.name === "linux-app-server-conversation-hydration",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-completed-item-recovery" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          !report.patches.some((patch) => patch.name === "linux-completed-item-recovery"),
        );
        assert.ok(
          !report.patches.some((patch) => patch.name === "linux-remote-terminal-status-recovery"),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-terminal-status-recovery" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-status-read-guard" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-status-wait" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-enablement-bridge" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-active-status" &&
            patch.status === "applied",
          ),
        );

        const secondReport = createPatchReport();
        patchExtractedApp(tempApp, { report: secondReport });
        assert.ok(
          secondReport.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-completed-item-recovery" &&
            patch.status === "already-applied",
          ),
        );
        assert.ok(
          secondReport.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-terminal-status-recovery" &&
            patch.status === "already-applied",
          ),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});
