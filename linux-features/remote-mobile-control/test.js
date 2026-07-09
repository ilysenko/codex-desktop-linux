#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
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
  applyLinuxRemoteControlClientAccountCompatibilityPatch,
  applyLinuxRemoteControlClientRevokeSetupResetPatch,
  applyLinuxRemoteControlClientRevocationRecoveryPatch,
  applyLinuxRemoteControlCopyPatch,
  applyLinuxRemoteControlPreserveConfigPatch,
  applyLinuxRemoteControlFeatureSyncPatch,
  applyLinuxRemoteControlEnableForHostParamsPatch,
  applyLinuxRemoteControlLoadGatePatch,
  applyLinuxRemoteControlEnablementBridgePatch,
  applyLinuxRemoteMobileActiveStatusPatch,
  applyLinuxRemoteMobileAppServerRemoteControlPatch,
  applyLinuxRemoteMobileChromeBridgePatch,
  applyLinuxRemoteMobileConversationHydrationPatch,
  applyLinuxRemoteControlStatusReadGuardPatch,
  applyLinuxRemoteMobileProjectlessRemoteTaskPatch,
  applyLinuxRemoteConnectionsRefreshPatch,
  applyLinuxRemoteControlSettingsUxPatch,
  applyLinuxRemoteControlSelectedTabPatch,
  applyLinuxRemoteControlVisibilityPatch,
} = require("./patch.js");

const REPO_ROOT = path.resolve(__dirname, "../..");
const PROJECTLESS_REMOTE_TASK_ASSET =
  "app-initial~app-main~remote-conversation-page~new-thread-panel-page~onboarding-page~appgen-~o4yhvtva-CRxLUCiX.js";

function syntheticMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function TV(e){return Buffer.from(JSON.stringify(e),`utf8`)}",
    "var bV=(0,b.createRequire)(__filename),xV=`remote-control-device-key.node`,SV=`codex-device-key-sign-payload/v1`;",
    "function wV({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=bV(i.join(e,`native`,xV)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=TV(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await hV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),pV))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticVisibilityBundle() {
  return "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}export{a as t};";
}

function syntheticCurrentMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function mz(e){return Buffer.from(JSON.stringify({domain:`codex-device-key-sign-payload/v1`,payload:e}),`utf8`)}",
    "var lz=(0,b.createRequire)(__filename),uz=`remote-control-device-key.node`,dz=`codex-device-key-sign-payload/v1`;",
    "function pz({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=lz((0,i.join)(e,`native`,uz)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=mz(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function vV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await yV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),_V))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticCryptoAliasCollisionMainBundle() {
  return [
    "let a=require(`node:path`),o=require(`node:fs`),c=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function mz(e){return Buffer.from(JSON.stringify({domain:`codex-device-key-sign-payload/v1`,payload:e}),`utf8`)}",
    "var lz=(0,b.createRequire)(__filename),uz=`remote-control-device-key.node`,dz=`codex-device-key-sign-payload/v1`;",
    "function pz({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=lz((0,a.join)(e,`native`,uz)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=mz(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
  ].join("");
}

function syntheticOldClientEnrollmentBundle() {
  return [
    "async function dd({appServerClient:e,desktopApiOptions:t,deviceKeyClient:n,globalState:r}){let i=Sd(await md({action:`check remote control authorization`,appServerClient:e,desktopApiOptions:t})).tokenAccountUserId;if(i==null)return{clientAuthorized:!1,clientId:null};let a=await Ld({deviceKeyClient:n,enrollmentKey:pd(fd(t),i),globalState:r});return{clientAuthorized:a!=null,clientId:a?.clientId??null}}",
    "function fd(e){return[e.desktopOriginator,e.devApiBaseUrl,e.prodApiBaseUrl].join(`\\n`)}",
    "function pd(e,t){return`${e}\\n${t}`}",
    "async function md({action:e=`connect remote control environments`,appServerClient:t,desktopApiOptions:n,headers:r}){return Ou({action:e,appServerClient:t,desktopOriginator:n.desktopOriginator,headers:r})}",
    "async function hd({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o}){let s=Sd(a),c=s.tokenAccountUserId;if(c==null)throw Error(`Remote control enrollment requires the current ChatGPT account user id.`);let l=pd(r,c),u=await Ld({deviceKeyClient:t,enrollmentKey:l,globalState:i}),d=u,f;if(d==null){if(o==null)throw Error(`Remote control enrollment requires explicit authorization in settings.`);Qu().info(`remote_control_client_enrollment_start_request`,{...Cd({authIdentity:s,hasExistingEnrollment:!1})});let r=await jd({appServerClient:e,body:{},desktopApiOptions:n,headers:a});if(Qu().info(`remote_control_client_enrollment_start_response`,{...Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseClientId:r.client_id,responseChallengeId:r.device_key_challenge.challenge_id})}),r.account_user_id!==c)throw Qu().warning(`remote_control_client_enrollment_start_account_mismatch`,{...Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseClientId:r.client_id,responseChallengeId:r.device_key_challenge.challenge_id})}),Error(`Remote control enrollment start does not match current account.`);d=await Vd({accountUserId:c,clientId:r.client_id,deviceKeyClient:t});try{if(Qu().info(`remote_control_client_enrollment_key_created`,{safe:{algorithm:d.algorithm,protectionClass:d.protectionClass},sensitive:{accountUserId:d.accountUserId,clientId:d.clientId,keyId:d.keyId}}),o==null)throw Error(`Remote control enrollment requires a step-up authorization flow.`);Qu().info(`remote_control_client_enrollment_step_up_requested`,{...Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseChallengeId:r.device_key_challenge.challenge_id,responseClientId:r.client_id})});let u=await o(),p=Td({accountUserId:c,stepUpToken:u}),m=Cd({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:r.account_user_id,responseChallengeId:r.device_key_challenge.challenge_id,responseClientId:r.client_id});Qu().info(`remote_control_client_enrollment_step_up_validated`,{safe:{...m.safe,stepUpTokenScopes:p.scopes},sensitive:{...m.sensitive,stepUpIssuedAt:p.issuedAt,stepUpPasswordAuthTime:p.passwordAuthTime,stepUpTokenAccountUserId:p.accountUserId}}),f=await Md({appServerClient:e,body:{client_id:d.clientId,step_up_token:u,device_identity:Ud(d),device_key_proof:await Gd({challenge:r.device_key_challenge,deviceKeyClient:t,desktopApiOptions:n,enrollment:d,expectedPath:`/codex/remote/control/client/enroll/finish`,requireDeviceIdentityHash:!1})},desktopApiOptions:n,headers:a}),Qu().info(`remote_control_client_enrollment_finish_response`,{...wd(f)}),_d(f,d),Rd(i,l,d)}catch(e){throw await Hd({deviceKeyClient:t,enrollment:d}),e}}else{Qu().info(`remote_control_client_refresh_start_request`,{...Cd({authIdentity:s,existingEnrollment:u,hasExistingEnrollment:!0})});let c;try{c=await Nd({appServerClient:e,body:{client_id:d.clientId},desktopApiOptions:n,headers:a})}catch(s){if(!Bd(s))throw s;return await Hd({deviceKeyClient:t,enrollment:d}),zd(i,l),hd({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o})}if(Qu().info(`remote_control_client_refresh_start_response`,{...Cd({authIdentity:s,existingEnrollment:u,hasExistingEnrollment:!0,responseAccountUserId:c.account_user_id,responseClientId:c.client_id,responseChallengeId:c.device_key_challenge.challenge_id})}),c.client_id!==d.clientId||c.account_user_id!==d.accountUserId)throw Error(`Remote control refresh challenge does not match local enrollment.`);f=await Pd({appServerClient:e,body:{client_id:d.clientId,device_key_proof:await Gd({challenge:c.device_key_challenge,deviceKeyClient:t,desktopApiOptions:n,enrollment:d,expectedPath:`/codex/remote/control/client/refresh/finish`,requireDeviceIdentityHash:!0})},desktopApiOptions:n,headers:a})}let p=_d(f,d);return{clientId:f.client_id,headers:{\"x-codex-client-session-token\":`Bearer ${f.remote_control_token}`},tokenExpiresAt:p.tokenExpiresAt,scopes:p.scopes,requiresDeviceKeyProof:!0}}",
    "function Td({accountUserId:e,stepUpToken:t}){let n=Od(t);Dd({payload:n});let r=od.parse(n),i=r[`https://api.openai.com/auth`],a=i.chatgpt_account_user_id??i.account_user_id,o=Ed(r);if(a!==e)throw Error(`Remote control enrollment step-up token does not match current account.`);if(Math.floor(Date.now()/1e3)-r.iat>id)throw Error(`Remote control enrollment step-up token is not fresh.`);if(Date.now()-r.pwd_auth_time>id*1e3)throw Error(`Remote control enrollment step-up token does not have fresh password auth.`);if(o.length!==1||o[0]!==rd)throw Error(`Remote control enrollment step-up token is missing required authorization.`);return{accountUserId:a??null,issuedAt:r.iat,passwordAuthTime:r.pwd_auth_time,scopes:o}}",
  ].join("");
}

function syntheticCurrentClientEnrollmentBundle() {
  return [
    "async function kf({appServerClient:e,desktopApiOptions:t,deviceKeyClient:n,globalState:r}){let i=Bf(await Mf({action:`check remote control authorization`,appServerClient:e,desktopApiOptions:t})).tokenAccountUserId;if(i==null)return{clientAuthorized:!1,clientId:null};let a=await tp({deviceKeyClient:n,enrollmentKey:jf(Af(t),i),globalState:r});return{clientAuthorized:a!=null,clientId:a?.clientId??null}}",
    "function Af(e){return[e.desktopOriginator,e.devApiBaseUrl,e.prodApiBaseUrl].join(`\\n`)}",
    "function jf(e,t){return`${e}\\n${t}`}",
    "async function Mf({action:e=`connect remote control environments`,appServerClient:t,desktopApiOptions:n,headers:r}){return Yd({action:e,appServerClient:t,desktopOriginator:n.desktopOriginator,headers:r})}",
    "async function Nf({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o}){let s=Bf(a),c=s.tokenAccountUserId;if(c==null)throw Error(`Remote control enrollment requires the current ChatGPT account user id.`);let l=jf(r,c),u=await tp({deviceKeyClient:t,enrollmentKey:l,globalState:i}),d=u,f;if(d==null){if(o==null)throw Error(`Remote control enrollment requires explicit authorization in settings.`);bf().info(`remote_control_client_enrollment_start_request`,{...Vf({authIdentity:s,hasExistingEnrollment:!1})});let l=await Yf({appServerClient:e,body:{},desktopApiOptions:n,headers:a});if(bf().info(`remote_control_client_enrollment_start_response`,{...Vf({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:l.account_user_id,responseClientId:l.client_id,responseChallengeId:l.device_key_challenge.challenge_id})}),l.account_user_id!==c&&!(s.tokenAccountId!=null&&s.headerChatGptAccountId===s.tokenAccountId&&s.tokenAuthUserId===l.account_user_id))throw bf().warning(`remote_control_client_enrollment_start_account_mismatch`,{...Vf({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:l.account_user_id,responseClientId:l.client_id,responseChallengeId:l.device_key_challenge.challenge_id})}),Error(`Remote control enrollment start does not match current account.`);d=await ap({accountUserId:l.account_user_id,clientId:l.client_id,deviceKeyClient:t});try{if(bf().info(`remote_control_client_enrollment_key_created`,{safe:{algorithm:d.algorithm,protectionClass:d.protectionClass},sensitive:{accountUserId:d.accountUserId,clientId:d.clientId,keyId:d.keyId}}),o==null)throw Error(`Remote control enrollment requires a step-up authorization flow.`);bf().info(`remote_control_client_enrollment_step_up_requested`,{...Vf({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:l.account_user_id,responseChallengeId:l.device_key_challenge.challenge_id,responseClientId:l.client_id})});let u=await o(),p=Uf({accountUserId:c,stepUpToken:u}),m=Vf({authIdentity:s,hasExistingEnrollment:!1,responseAccountUserId:l.account_user_id,responseChallengeId:l.device_key_challenge.challenge_id,responseClientId:l.client_id});bf().info(`remote_control_client_enrollment_step_up_validated`,{safe:{...m.safe,stepUpTokenScopes:p.scopes},sensitive:{...m.sensitive,stepUpIssuedAt:p.issuedAt,stepUpPasswordAuthTime:p.passwordAuthTime,stepUpTokenAccountUserId:p.accountUserId}}),f=await Xf({appServerClient:e,body:{client_id:d.clientId,step_up_token:u,device_identity:sp(d),device_key_proof:await lp({challenge:l.device_key_challenge,deviceKeyClient:t,desktopApiOptions:n,enrollment:d,expectedPath:`/codex/remote/control/client/enroll/finish`,requireDeviceIdentityHash:!1})},desktopApiOptions:n,headers:a}),bf().info(`remote_control_client_enrollment_finish_response`,{...Hf(f)}),Ff(f,d),np(i,jf(r,d.accountUserId),d)}catch(e){throw await op({deviceKeyClient:t,enrollment:d}),e}}else{bf().info(`remote_control_client_refresh_start_request`,{...Vf({authIdentity:s,existingEnrollment:u,hasExistingEnrollment:!0})});let c;try{c=await Zf({appServerClient:e,body:{client_id:d.clientId},desktopApiOptions:n,headers:a})}catch(s){if(!ip(s))throw s;return await op({deviceKeyClient:t,enrollment:d}),rp(i,l),Nf({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o})}if(bf().info(`remote_control_client_refresh_start_response`,{...Vf({authIdentity:s,existingEnrollment:u,hasExistingEnrollment:!0,responseAccountUserId:c.account_user_id,responseClientId:c.client_id,responseChallengeId:c.device_key_challenge.challenge_id})}),c.client_id!==d.clientId||c.account_user_id!==d.accountUserId)throw Error(`Remote control refresh challenge does not match local enrollment.`);f=await Qf({appServerClient:e,body:{client_id:d.clientId,device_key_proof:await lp({challenge:c.device_key_challenge,deviceKeyClient:t,desktopApiOptions:n,enrollment:d,expectedPath:`/codex/remote/control/client/refresh/finish`,requireDeviceIdentityHash:!0})},desktopApiOptions:n,headers:a})}let p=Ff(f,d);return{clientId:f.client_id,headers:{\"x-codex-client-session-token\":`Bearer ${f.remote_control_token}`},tokenExpiresAt:p.tokenExpiresAt,scopes:p.scopes,requiresDeviceKeyProof:!0}}",
    "function Uf({accountUserId:t,stepUpToken:n}){let r=Kf(n);Gf({payload:r});let i=e.J.parse(r),a=i[`https://api.openai.com/auth`],o=a.chatgpt_account_user_id??a.account_user_id,s=Wf(i);if(o!==t)throw new Sf;if(Math.floor(Date.now()/1e3)-i.iat>wf)throw Error(`Remote control enrollment step-up token is not fresh.`);if(Date.now()-i.pwd_auth_time>wf*1e3)throw Error(`Remote control enrollment step-up token does not have fresh password auth.`);if(s.length!==1||s[0]!==Cf)throw Error(`Remote control enrollment step-up token is missing required authorization.`);return{accountUserId:o??null,issuedAt:i.iat,passwordAuthTime:i.pwd_auth_time,scopes:s}}",
  ].join("");
}

function syntheticNativeClientEnrollmentBundle() {
  return [
    "function Af(e){return[e.desktopOriginator,e.devApiBaseUrl,e.prodApiBaseUrl].join(`\\n`)}",
    "function jf(e,t){return`${e}\\n${t}`}",
    "function Th(e){if(e.tokenAccountUserId==null)return[];let t=[e.tokenAccountUserId];return e.tokenAccountId!=null&&e.headerChatGptAccountId===e.tokenAccountId&&e.tokenAuthUserId!=null&&e.tokenAuthUserId!==e.tokenAccountUserId&&t.push(e.tokenAuthUserId),t}",
    "async function wh({authIdentity:e,enrollmentKey:t,deviceKeyClient:n,globalState:r}){let i=(await Promise.all(Th(e).map(async e=>{let i=jf(t,e);return{enrollment:await tp({deviceKeyClient:n,enrollmentKey:i,globalState:r}),enrollmentRecordKey:i}}))).find(e=>e.enrollment!=null);return i?.enrollment==null?null:i}",
    "async function Nf({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o}){let s=Bf(a),c=s.tokenAccountUserId;if(c==null)throw Error(`Remote control enrollment requires the current ChatGPT account user id.`);let l=jf(r,c),u=await wh({authIdentity:s,deviceKeyClient:t,enrollmentKey:r,globalState:i}),d=u?.enrollment??null,f;if(d==null){let l=await Yf({appServerClient:e,body:{},desktopApiOptions:n,headers:a});if(l.account_user_id!==c&&!(s.tokenAccountId!=null&&s.headerChatGptAccountId===s.tokenAccountId&&s.tokenAuthUserId===l.account_user_id))throw bf().warning(`remote_control_client_enrollment_start_account_mismatch`,{}),Error(`Remote control enrollment start does not match current account.`);d=await ap({accountUserId:l.account_user_id,clientId:l.client_id,deviceKeyClient:t}),np(i,jf(r,d.accountUserId),d)}return{clientId:f?.client_id??d.clientId}}",
  ].join("");
}

function syntheticAlreadyCompatibleCurrentClientEnrollmentBundle() {
  return [
    "function Mf(e,t){return`${e}\\n${t}`}",
    "function np(e){if(e.tokenAccountUserId==null)return[];let t=[e.tokenAccountUserId];return e.tokenAccountId!=null&&e.headerChatGptAccountId===e.tokenAccountId&&e.tokenAuthUserId!=null&&e.tokenAuthUserId!==e.tokenAccountUserId&&t.push(e.tokenAuthUserId),t}",
    "function tp({authIdentity:e,connectionKey:t,deviceKeyClient:n,globalState:r}){let i=(await Promise.all(np(e).map(async e=>{let i=Mf(t,e);return{key:i,record:await ip({deviceKeyClient:n,enrollmentKey:i,globalState:r})}}))).find(e=>e.record!=null);return i?.record==null?null:{key:i.key,record:i.record}}",
    "async function Pf({appServerClient:e,deviceKeyClient:t,desktopApiOptions:n,enrollmentKey:r,globalState:i,headers:a,requestRemoteControlEnrollmentStepUpToken:o}){let s=Vf(a),c=s.tokenAccountUserId;if(c==null)throw Error(`Remote control enrollment requires the current ChatGPT account user id.`);let l=s.tokenAccountId??s.headerChatGptAccountId,u=await tp({authIdentity:s,connectionKey:r,deviceKeyClient:t,globalState:i}),d=u?.record??null,f=u?.key??Mf(r,c),p=d,m;if(p==null){let u=await Xf({appServerClient:e,body:{},desktopApiOptions:n,headers:a});if(u.account_user_id!==c&&!(s.tokenAccountId!=null&&s.headerChatGptAccountId===s.tokenAccountId&&s.tokenAuthUserId===u.account_user_id))throw Error(`Remote control enrollment start does not match current account.`);let d=await o({accountId:l}),h=Wf({accountUserId:c,stepUpToken:d});m=await Zf({appServerClient:e,body:{client_id:p?.clientId??null,step_up_token:d},desktopApiOptions:n,headers:a})}return{clientId:m?.client_id??null,key:f}}",
  ].join("");
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
  return [
    "function Pd(e){let t=e.hostConfig.codex_cli_command;if(t&&t.length>0){let[e,...n]=t;return!e||e.trim().length===0?null:{executablePath:e,args:n}}let n=Kd();if(n!=null)return{executablePath:n,args:[`app-server`,`--analytics-default-enabled`]};let r=Nd(e.repoRoot,{resourcesPath:e.resourcesPath});return r?{executablePath:r.executablePath,args:[`app-server`,`--analytics-default-enabled`],binDirectory:r.binDirectory}:null}",
    "function Fd(e){let t=e.hostConfig.codex_cli_command;if(t&&t.length>0){let[e,...n]=t;if(!e||e.trim().length===0)return null;return{executablePath:e,args:n}}let n=Kd();if(n!=null)return{executablePath:n,args:[`app-server`,`--analytics-default-enabled`]};let r=Ud(e.repoRoot,{resourcesPath:e.resourcesPath,windowsCodexHome:e.windowsCodexHome});return r?{executablePath:r.executablePath,args:[`app-server`,`--analytics-default-enabled`],binDirectory:r.binDirectory}:null}",
  ].join("");
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

function syntheticRevokeSetupResetBundle() {
  return [
    "function b(e,t){e.events.push(t)}",
    "let J={},t={ADDED_REMOTE_CONTROL_ENV_IDS:`added-remote-control-env-ids`},e={},ye=[];",
    "function ie(e,t,n){e.globalState[t]=n}",
    "function ee(e){return e}",
    "var vt=`remote-control-client-revoke-success`,yt=`remote-control-client-revoke-error`;",
    "function Ct(){let i={events:[],globalState:{\"codex-mobile-has-connected-device\":!0},get(){return{success(){}}},query:{snapshot(){return{data:[],setData(e){this.data=e(this.data)},invalidate(){this.invalidated=!0}}}}},v=i.query.snapshot(tt),y;",
    "y=(e,t)=>{let{clientId:n}=t;b(i,{eventName:`codex_remote_control_client_revoke_result`,metadata:{result:`succeeded`}}),v.setData(e=>e?.filter(e=>e.client_id!==n)),v.invalidate(),i.get(J).success(`Revoked device access`,{id:vt})};",
    "return{handler:y,query:v,store:i}}",
    "var Ue=ee({mutationFn:n=>ie(e,t.ADDED_REMOTE_CONTROL_ENV_IDS,[...ye,...n])}),tt={};",
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

function syntheticAppServerManagerStatusBundle() {
  return [
    "var z={error(){}};",
    "var bO={};",
    "function wO(e,t){return e.bump(t)}",
    "function TO(e,t,n){return e.current(t)===n}",
    "function SO(e,t){let n=t.getHostId(),r=wO(e,n),i=e.get(bO,n);t.addNotificationCallback(`remoteControl/status/changed`,({params:t})=>{TO(e,n,r)&&e.set(bO,n,t)}),t.sendRequest(`remoteControl/status/read`,void 0).then(t=>{e.get(bO,n)===i&&TO(e,n,r)&&e.set(bO,n,t)}).catch(t=>{TO(e,n,r)&&z.error(`Failed to read remote-control status`,{safe:{},sensitive:{error:t}})})}",
  ].join("");
}

function syntheticAppMainActiveStatusBundle() {
  return [
    "function pS({latestTurnStatus:e,resumeState:t,streamRole:n,threadRuntimeStatus:r}){return n==null?t===`needs_resume`?`needs-resume`:`read-only`:n.role===`follower`?`follower`:r?.type===`active`||e===`inProgress`?`active`:`inactive`}",
  ].join("");
}

function syntheticSidebarProjectGroupsBundle() {
  return [
    "function AD(e,t,n){let r=MD(e,t),i=ND(r);if(!i){RD.has(e.task.id)||(RD.add(e.task.id),y.warning(`No owner repo found for remote task`,{safe:{taskId:e.task.id},sensitive:{}}));return}let a=i.repoName.toLowerCase();(n.find(e=>hD(e.repositoryData?.ownerRepo,i)&&e.repositoryData?.repoPath===``&&e.repositoryData?.rootFolder?.toLowerCase()===a)??null??n.find(e=>hD(e.repositoryData?.ownerRepo,i))??jD(i,r,n)).threadKeys.push(e.key)}",
  ].join("");
}

function syntheticAppMainEnablementBridgeBundle() {
  return [
    "var DF=`[remote-connections/slingshot-gate-bridge]`;",
    "function OF(){let e=(0,Z.c)(3),t=sc(),n,r;return e[0]===t?(n=e[1],r=e[2]):(n=()=>{$o(`set-remote-control-connections-enabled`,{params:{enabled:t}}).catch(e=>{q.warning(`${DF} sync_failed`,{safe:{enabled:t},sensitive:{error:e}})})},r=[t],e[0]=t,e[1]=n,e[2]=r),(0,Q.useEffect)(n,r),null}",
  ].join("");
}

function syntheticCurrentAppMainEnablementBridgeBundle() {
  return [
    "var fH=`[remote-connections/slingshot-gate-bridge]`;",
    "function mH(){let e=(0,Q.c)(6),{checkGate:t,isLoading:n}=eo(),r;e[0]===t?r=e[1]:(r=t(`1042620455`),e[0]=t,e[1]=r);let i=r,a,o;return e[2]!==n||e[3]!==i?(a=()=>{n||qt(`set-remote-control-connections-enabled`,{params:{enabled:i}}).catch(e=>{Y.warning(`${fH} sync_failed`,{safe:{slingshotEnabled:i},sensitive:{error:e}})})},o=[n,i],e[2]=n,e[3]=i,e[4]=a,e[5]=o):(a=e[4],o=e[5]),(0,$.useEffect)(a,o),null}",
    "var handlers={\"set-remote-control-enabled-for-host\":pU((e,{enabled:t})=>e.sendRequest(t?`remoteControl/enable`:`remoteControl/disable`,null))};",
  ].join("");
}

function syntheticSelectedTabBundle() {
  return [
    "function nr(e,t){return e.displayName.localeCompare(t.displayName)}",
    "function rr({selectedConnectionsTab:e,showControlThisMacTab:t,showRemoteControlConnectionsSection:n,showTabbedSshPage:r}){return n?e===`control-this-mac`&&!t||e===`ssh`&&!r?`access-other-devices`:e:`ssh`}",
  ].join("");
}

function syntheticCurrentSelectedTabBundle() {
  return "function Pe({selectedConnectionsTab:e,showControlOtherDevices:t,showControlThisMacTab:n,showRemoteControlConnectionsSection:r,showRemoteSshConnections:i,showTabbedSshPage:a}){return r?e===`control-this-mac`&&!n?t?`access-other-devices`:`ssh`:e===`access-other-devices`&&!t?n?`control-this-mac`:`ssh`:e===`ssh`&&!a?t?`access-other-devices`:`control-this-mac`:e:i?`ssh`:`access-other-devices`}";
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
    fs.writeFileSync(systemctl, "#!/usr/bin/env sh\nexit 3\n");
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
  fs.writeFileSync(marker, "desktop-app-server-remote-control\n");
}

test("remote mobile control feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("remote mobile stage hook writes installed Desktop app-server ownership marker from patched app layout", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");
    const coldStartHook = path.join(installDir, ".codex-linux", "cold-start.d", "remote-mobile-control");

    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "globalThis.codexLinuxRemoteMobileAppServerArgs=true;");

    const result = runStageHook({
      ARCH: "x64",
      CODEX_UPSTREAM_APP_DIR: path.join(tempRoot, "upstream-app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(marker, "utf8"), "desktop-app-server-remote-control\n");
    assert.equal(fs.existsSync(coldStartHook), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile stage hook leaves Desktop ownership marker absent when patch marker is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-stage-"));
  try {
    const installDir = path.join(tempRoot, "package", "opt", "codex-desktop");
    const workDir = path.join(tempRoot, "work");
    const buildDir = path.join(workDir, "app-extracted", ".vite", "build");
    const marker = path.join(installDir, ".codex-linux", "desktop-app-server-remote-control-enabled");

    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "globalThis.someOtherPatch=true;");

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
    assert.match(result.stdout, /Desktop app-server launches with remote-control enabled/);
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
    assert.match(result.stdout, /Desktop app-server launches with remote-control enabled/);
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
    assert.match(result.stdout, /Desktop app-server launches with remote-control enabled/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("remote mobile control feature exposes opt-in main-bundle and webview patches", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
      "feature:remote-mobile-control:linux-remote-control-device-key",
      "feature:remote-mobile-control:linux-remote-control-preserve-config",
      "feature:remote-mobile-control:linux-remote-control-client-account-compatibility",
      "feature:remote-mobile-control:linux-remote-control-client-revocation-recovery",
      "feature:remote-mobile-control:linux-remote-mobile-app-server-remote-control",
      "feature:remote-mobile-control:linux-remote-control-load-gate",
      "feature:remote-mobile-control:linux-remote-control-feature-sync",
      "feature:remote-mobile-control:linux-remote-control-visibility",
      "feature:remote-mobile-control:linux-remote-control-copy",
      "feature:remote-mobile-control:linux-remote-control-settings-ux",
      "feature:remote-mobile-control:linux-remote-control-selected-tab",
      "feature:remote-mobile-control:linux-remote-control-client-revoke-setup-reset",
      "feature:remote-mobile-control:linux-remote-connections-refresh",
      "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration",
      "feature:remote-mobile-control:linux-remote-control-status-read-guard",
      "feature:remote-mobile-control:linux-remote-control-enable-for-host-params",
      "feature:remote-mobile-control:linux-remote-control-enablement-bridge",
      "feature:remote-mobile-control:linux-remote-mobile-active-status",
      "feature:remote-mobile-control:linux-remote-mobile-projectless-remote-task",
    ]);
    assert.deepEqual(descriptors.map((descriptor) => descriptor.phase), [
      "main-bundle",
      "main-bundle",
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
    ]);

    const visibilityDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-visibility"
    );
    assert.ok(visibilityDescriptor);
    assert.equal(visibilityDescriptor.pattern.test("remote-connections-settings-fixture.js"), true);
    assert.equal(visibilityDescriptor.pattern.test("use-plugin-install-flow-fixture.js"), true);
    assert.equal(visibilityDescriptor.pattern.test("app-main-fixture.js"), false);

    const statusGuardDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-control-status-read-guard"
    );
    assert.ok(statusGuardDescriptor);
    assert.equal(
      statusGuardDescriptor.pattern.test(
        "app-initial~app-main~worktree-init-v2-page~remote-conversation-page~pull-requests-page~plug~kmtatxxf-IUI8plS9.js",
      ),
      true,
    );

    const hydrationDescriptor = descriptors.find((descriptor) =>
      descriptor.id === "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration"
    );
    assert.ok(hydrationDescriptor);
    assert.equal(hydrationDescriptor.pattern.test("app-server-manager-signals-test.js"), true);
    assert.equal(
      hydrationDescriptor.pattern.test(
        "app-initial~app-main~worktree-init-v2-page~remote-conversation-page~onboarding-page~hotkey-~ke3yc5wu-BLQiF1Gs.js",
      ),
      true,
    );
    assert.equal(hydrationDescriptor.pattern.test("remote-connections-settings-fixture.js"), false);
  });
});

test("Linux remote-control patches update the device-key provider and preserve config", () => {
  const source = syntheticMainBundle();
  const patched = applyLinuxRemoteControlPreserveConfigPatch(
    applyLinuxRemoteControlDeviceKeyPatch(source),
  );

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(
    applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(patched)),
    patched,
  );
});

test("Linux remote-control device-key patch handles current minified aliases", () => {
  const source = syntheticCurrentMainBundle();
  const patched = applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(source));

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(patched)), patched);
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

test("Linux remote-control client enrollment accepts account-scoped and base user ids", () => {
  const source = syntheticOldClientEnrollmentBundle();
  const patched = applyLinuxRemoteControlClientAccountCompatibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlAccountMatches/);
  assert.match(patched, /codexLinuxRemoteControlLoadEnrollment/);
  assert.doesNotMatch(patched, /account_user_id!==c/);
  assert.match(patched, /accountUserId:r\.account_user_id/);
  assert.match(patched, /l=pd\(codexLinuxRemoteControlEnrollmentKey,d\.accountUserId\)/);
  assert.match(
    patched,
    /Td\(\{accountId:codexLinuxRemoteControlCurrentAccountId,accountUserId:d\.accountUserId,stepUpToken:u\}\)/,
  );
  assert.match(patched, /clientId:a\?\.enrollment\.clientId\?\?null/);
  assert.equal(applyLinuxRemoteControlClientAccountCompatibilityPatch(patched), patched);
});

test("Linux remote-control client enrollment handles current upstream account compatibility shape", () => {
  const source = syntheticCurrentClientEnrollmentBundle();
  const patched = applyLinuxRemoteControlClientAccountCompatibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlAccountMatches/);
  assert.match(patched, /codexLinuxRemoteControlLoadEnrollment/);
  assert.match(patched, /let i=jf\(n,e\)/);
  assert.doesNotMatch(patched, /l=jf\(codexLinuxRemoteControlEnrollmentKey,d\.accountUserId\);try/);
  assert.match(patched, /u=await o\(\{accountId:codexLinuxRemoteControlCurrentAccountId\}\)/);
  assert.match(patched, /Uf\(\{accountId:codexLinuxRemoteControlCurrentAccountId,accountUserId:d\.accountUserId,stepUpToken:u\}\)/);
  assert.match(patched, /codexLinuxStepUpClaims=e\.J\.parse\(codexLinuxStepUpPayload\)/);
  assert.doesNotMatch(patched, /function Uf\(\{accountId:e,accountUserId:t,stepUpToken:n\}\)/);
  assert.match(patched, /clientId:a\?\.enrollment\.clientId\?\?null/);
  assert.equal(applyLinuxRemoteControlClientAccountCompatibilityPatch(patched), patched);
});

test("Linux remote-control client enrollment no-ops only on complete native compatibility", () => {
  const source = syntheticNativeClientEnrollmentBundle();
  const patched = applyLinuxRemoteControlClientAccountCompatibilityPatch(source);

  assert.equal(patched, source);
});

test("Linux remote-control client enrollment does not hide partial native drift", () => {
  const source = [
    "function jf(e,t){return`${e}\\n${t}`}",
    "function Th(e){if(e.tokenAccountUserId==null)return[];return[e.tokenAccountUserId]}",
    "function marker({candidateAccountUserId:e,expectedAccountUserId:t,tokenAuthUserId:n}){return e===t||n===t}",
    "async function Nf(){let s=Bf(a),c=s.tokenAccountUserId,l=await Yf();if(l.account_user_id!==c)throw bf().warning(`remote_control_client_enrollment_start_account_mismatch`,{}),Error(`Remote control enrollment start does not match current account.`)}",
  ].join("");
  const { result, warnings } = captureWarnings(() =>
    applyLinuxRemoteControlClientAccountCompatibilityPatch(source),
  );

  assert.equal(result, source);
  assert.ok(warnings.some((warning) => warning.includes("enrollment start shape")));
});

test("Linux remote-control client enrollment leaves current upstream-compatible shape untouched", () => {
  const source = syntheticAlreadyCompatibleCurrentClientEnrollmentBundle();
  const patched = applyLinuxRemoteControlClientAccountCompatibilityPatch(source);

  assert.equal(patched, source);
  assert.match(patched, /function tp\(\{authIdentity:e,connectionKey:t,deviceKeyClient:n,globalState:r\}\)/);
  assert.match(patched, /u\?\.key\?\?Mf\(r,c\)/);
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
    /process\.platform===`linux`\?\[`app-server`,`--remote-control`,`--analytics-default-enabled`\]:\[`app-server`,`--analytics-default-enabled`\]/,
  );
  assert.doesNotMatch(patched, /args:\[`app-server`,`--analytics-default-enabled`\]/);
  assert.match(patched, /args:codexLinuxRemoteMobileAppServerArgs\(\)/);
  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(patched), patched);
});

test("Linux remote mobile app-server launch keeps a leading use strict directive first", () => {
  const source = `"use strict";${syntheticAppServerLaunchBundle()}`;
  const patched = applyLinuxRemoteMobileAppServerRemoteControlPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /^"use strict";function codexLinuxRemoteMobileAppServerArgs/);
  assert.equal(applyLinuxRemoteMobileAppServerRemoteControlPatch(patched), patched);
});

test("Linux remote-control client revoke clears setup completion after last client is removed", () => {
  const source = syntheticRevokeSetupResetBundle();
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlResetMobileSetupAfterRevoke/);
  assert.match(patched, /codex-mobile-has-connected-device/);
  assert.equal(applyLinuxRemoteControlClientRevokeSetupResetPatch(patched), patched);

  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=Ct();`, context);
  const { handler, query, store } = context.module.exports;
  query.data = [{ client_id: "phone_1" }];

  handler(null, { clientId: "phone_1" });

  assert.deepEqual(query.data, []);
  assert.equal(store.globalState["codex-mobile-has-connected-device"], false);
  assert.equal(query.invalidated, true);
});

test("Linux remote-control client revoke keeps setup completion while other clients remain", () => {
  const patched = applyLinuxRemoteControlClientRevokeSetupResetPatch(syntheticRevokeSetupResetBundle());
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${patched};module.exports=Ct();`, context);
  const { handler, query, store } = context.module.exports;
  query.data = [{ client_id: "phone_1" }, { client_id: "tablet_1" }];

  handler(null, { clientId: "phone_1" });

  assert.deepEqual(query.data, [{ client_id: "tablet_1" }]);
  assert.equal(store.globalState["codex-mobile-has-connected-device"], true);
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

test("Linux remote-control feature sync composes with core-sanitized dynamic builder", () => {
  const source = syntheticAppMainFeatureSyncBundle().replace("return n[vI]=t,n}", "return n}");
  const patched = applyLinuxRemoteControlFeatureSyncPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /\.remote_control=!0/);
  assert.match(patched, /codexLinuxRemoteControlFeatureSyncEnabled/);
  assert.doesNotMatch(patched, /n\[vI\]=t/);
  assert.match(patched, /:n\}/);
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

test("Linux remote-control visibility patch allows Linux when upstream marks availability false", () => {
  const source = syntheticVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
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

test("Linux remote-control selected-tab fallback keeps outbound control reachable on Linux", () => {
  const patched = applyLinuxRemoteControlSelectedTabPatch(syntheticSelectedTabBundle());
  assert.match(patched, /codexLinuxRemoteControlSelectedTab/);
  const context = {
    navigator: { userAgent: "Linux x86_64" },
    module: { exports: {} },
  };
  vm.runInNewContext(`${patched};module.exports=rr;`, context);
  const resolveTab = context.module.exports;

  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlThisMacTab: true,
      showRemoteControlConnectionsSection: true,
      showTabbedSshPage: true,
    }),
    "access-other-devices",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showTabbedSshPage: true,
    }),
    "access-other-devices",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "control-this-mac",
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showTabbedSshPage: true,
    }),
    "access-other-devices",
  );
  assert.equal(applyLinuxRemoteControlSelectedTabPatch(patched), patched);
});

test("Linux remote-control selected-tab patch handles the current six-param resolver", () => {
  const patched = applyLinuxRemoteControlSelectedTabPatch(syntheticCurrentSelectedTabBundle());
  assert.notEqual(patched, syntheticCurrentSelectedTabBundle());
  assert.match(patched, /codexLinuxRemoteControlSelectedTab/);
  const context = {
    navigator: { userAgent: "Linux x86_64" },
    module: { exports: {} },
  };
  vm.runInNewContext(`${patched};module.exports=Pe;`, context);
  const resolveTab = context.module.exports;

  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlOtherDevices: true,
      showControlThisMacTab: true,
      showRemoteControlConnectionsSection: true,
      showRemoteSshConnections: true,
      showTabbedSshPage: true,
    }),
    "access-other-devices",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlOtherDevices: true,
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showRemoteSshConnections: true,
      showTabbedSshPage: true,
    }),
    "access-other-devices",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "access-other-devices",
      showControlOtherDevices: false,
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showRemoteSshConnections: true,
      showTabbedSshPage: true,
    }),
    "ssh",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "control-this-mac",
      showControlOtherDevices: true,
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showRemoteSshConnections: true,
      showTabbedSshPage: true,
    }),
    "access-other-devices",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "ssh",
      showControlOtherDevices: true,
      showControlThisMacTab: true,
      showRemoteControlConnectionsSection: true,
      showRemoteSshConnections: true,
      showTabbedSshPage: false,
    }),
    "access-other-devices",
  );
  assert.equal(
    resolveTab({
      selectedConnectionsTab: "ssh",
      showControlOtherDevices: false,
      showControlThisMacTab: false,
      showRemoteControlConnectionsSection: true,
      showRemoteSshConnections: true,
      showTabbedSshPage: false,
    }),
    "ssh",
  );
  assert.equal(applyLinuxRemoteControlSelectedTabPatch(patched), patched);
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

test("Linux remote-control status guard migrates older remote-ssh-only guard", () => {
  const oldPatched = applyLinuxRemoteControlStatusReadGuardPatch(syntheticAppServerManagerStatusBundle()).replace(
    "||e.startsWith(`remote-control:`)",
    "",
  );
  const patched = applyLinuxRemoteControlStatusReadGuardPatch(oldPatched);

  assert.match(patched, /startsWith\(`remote-control:`\)/);
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
      fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));
      fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");
      fs.writeFileSync(path.join(assetsDir, "remote-connection-visibility-test.js"), syntheticRemoteConnectionVisibilityBundle());
      fs.writeFileSync(path.join(assetsDir, "app-main-test.js"), syntheticAppMainFeatureSyncBundle() + syntheticAppMainEnablementBridgeBundle() + syntheticAppMainActiveStatusBundle());
      fs.writeFileSync(
        path.join(assetsDir, "remote-connections-settings-test.js"),
        (syntheticSettingsBundle() + syntheticSshInstallSettingsBundle()).replace(
          "installedCodexVersion:h",
          "installedVersion:h",
        ),
      );
      fs.writeFileSync(
        path.join(assetsDir, "app-server-manager-signals-test.js"),
        syntheticAppServerManagerSignalsBundle().replace(
          "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{conversationId:r},sensitive:{}});break}",
          "if(!this.conversations.get(r)){z.error(`Received turn/completed for unknown conversation`,{safe:{id:r},sensitive:{}});break}",
        ) + syntheticAppServerManagerStatusBundle(),
      );
      fs.writeFileSync(path.join(assetsDir, PROJECTLESS_REMOTE_TASK_ASSET), syntheticSidebarProjectGroupsBundle());
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

      const hydrationPatch = report.patches.find(
        (patch) => patch.name === "linux-app-server-conversation-hydration",
      );
      assert.equal(hydrationPatch.sourceKind, "core");
      assert.equal(hydrationPatch.status, "applied-with-warnings");
      assert.ok(hydrationPatch.warnings.some((warning) => warning.includes("unknown turn/completed needle")));

      const featureHydrationPatch = report.patches.find(
        (patch) => patch.name === "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration",
      );
      assert.equal(featureHydrationPatch.sourceKind, "feature");
      assert.equal(featureHydrationPatch.status, "already-applied");
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});

test("Linux remote mobile projectless remote task patch groups tasks without owner repo metadata", () => {
  const source = syntheticSidebarProjectGroupsBundle();
  const patched = applyLinuxRemoteMobileProjectlessRemoteTaskPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteMobileProjectlessRemoteTaskId/);
  assert.match(patched, /projectId:`remote-task:\$\{codexLinuxRemoteMobileProjectlessRemoteTaskId\}`/);
  assert.match(patched, /repositoryData:null/);
  assert.match(patched, /threadKeys:\[\]/);
  assert.doesNotMatch(patched, /No owner repo found for remote task/);
  assert.equal(applyLinuxRemoteMobileProjectlessRemoteTaskPatch(patched), patched);
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
    sc: () => false,
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

test("Linux remote-control enablement bridge migrates old auto-connect cleanup patch", () => {
  const source = syntheticAppMainEnablementBridgeBundle().replace(
    "$o(`set-remote-control-connections-enabled`,{params:{enabled:t}}).catch(e=>{q.warning(`${DF} sync_failed`,{safe:{enabled:t},sensitive:{error:e}})})",
    "$o(`set-remote-control-connections-enabled`,{params:{enabled:t}}).then(async e=>{if(t&&typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)){await Promise.resolve(e)}}/*codexLinuxRemoteControlAutoConnectCleanup*/).catch(e=>{q.warning(`${DF} sync_failed`,{safe:{enabled:t},sensitive:{error:e}})})",
  );

  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

  assert.match(patched, /codexLinuxRemoteControlSelfAutoConnect/);
  assert.match(patched, /electron-local-remote-control-installation-id/);
  assert.doesNotMatch(patched, /codexLinuxRemoteControlAutoConnectCleanup/);
});

test("Linux remote-control enablement bridge auto-connects only this Desktop host", async () => {
  const source = syntheticAppMainEnablementBridgeBundle();
  const patched = applyLinuxRemoteControlEnablementBridgePatch(source);

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
    sc: () => false,
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
    const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticMainBundle());
    const context = {
      Buffer,
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

    const storePath = path.join(configHome, "codex-desktop", "remote-control-device-keys-v1.json");
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);

    await client.deleteDeviceKey(created.keyId);
    await assert.rejects(() => client.getDeviceKeyPublic(created.keyId), /not found/);
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
          path.join(assetsDir, "remote-connection-visibility-test.js"),
          syntheticRemoteConnectionVisibilityBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          syntheticVisibilityBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          syntheticSettingsBundle() +
            syntheticRemoteConnectionsSettingsCopyBundle() +
            syntheticSettingsRefreshBundle() +
            syntheticRevokeSetupResetBundle(),
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
          path.join(assetsDir, "app-server-manager-signals-test.js"),
          syntheticAppServerManagerSignalsBundle() + syntheticAppServerManagerStatusBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "app-main-test.js"),
          syntheticAppMainFeatureSyncBundle() +
            syntheticAppMainEnablementBridgeBundle() +
            syntheticAppMainActiveStatusBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, PROJECTLESS_REMOTE_TASK_ASSET),
          syntheticSidebarProjectGroupsBundle(),
        );

        const report = createPatchReport();
        patchExtractedApp(tempApp, { report });

        const patchedFile = fs.readFileSync(path.join(buildDir, "main.js"), "utf8");
        const patchedAppServerLaunchFile = fs.readFileSync(
          path.join(buildDir, "workspace-root-drop-handler-test.js"),
          "utf8",
        );
        const patchedVisibilityFile = fs.readFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          "utf8",
        );
        const patchedRemoteConnectionVisibilityFile = fs.readFileSync(
          path.join(assetsDir, "remote-connection-visibility-test.js"),
          "utf8",
        );
        const patchedAppMainFile = fs.readFileSync(
          path.join(assetsDir, "app-main-test.js"),
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
          path.join(assetsDir, "app-server-manager-signals-test.js"),
          "utf8",
        );
        const patchedSidebarProjectGroupsFile = fs.readFileSync(
          path.join(assetsDir, PROJECTLESS_REMOTE_TASK_ASSET),
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
        assert.match(patchedSignalsFile, /codexLinuxRemoteControlShouldReadStatus/);
        assert.match(patchedSidebarProjectGroupsFile, /codexLinuxRemoteMobileProjectlessRemoteTaskId/);
        assert.match(patchedAppMainFile, /codexLinuxRemoteControlEnablementBridge/);
        assert.match(patchedAppMainFile, /codexLinuxRemoteMobileActiveStatus/);
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
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-preserve-config" &&
            patch.status === "already-applied",
          ),
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
          report.patches.some((patch) =>
            patch.name === "linux-app-server-conversation-hydration" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration" &&
            patch.status === "already-applied",
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
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-mobile-projectless-remote-task" &&
            patch.status === "applied",
          ),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});
