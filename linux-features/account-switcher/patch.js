"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  extractedAppPatch,
  mainBundlePatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");

const MAIN_MARKER = "codexLinuxAccountSwitcherIpcV1";
const PRELOAD_MARKER = "codexLinuxAccountSwitcherBridgeV1";
const MENU_MARKER = "codexLinuxAccountSwitcherProfileMenuV1";
const RUNTIME_MARKER = "codexLinuxAccountSwitcherRuntimeV1";

const MAIN_RUNTIME = String.raw`;/*${MAIN_MARKER}*/(function(){
const codexLinuxAccountSwitcherFs=require("node:fs");
const codexLinuxAccountSwitcherPath=require("node:path");
const codexLinuxAccountSwitcherOs=require("node:os");
const codexLinuxAccountSwitcherHttps=require("node:https");
const codexLinuxAccountSwitcherChildProcess=require("node:child_process");
const codexLinuxAccountSwitcherIpc="codex_linux_account_switcher";
const codexLinuxAccountSwitcherHome=process.env.HOME||codexLinuxAccountSwitcherOs.homedir();
const codexLinuxAccountSwitcherConfigHome=process.env.XDG_CONFIG_HOME||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherHome,".config");
const codexLinuxAccountSwitcherDataHome=process.env.XDG_DATA_HOME||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherHome,".local","share");
const codexLinuxAccountSwitcherConfigDir=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigHome,"codex-desktop");
const codexLinuxAccountSwitcherConfigPath=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"account-switcher.json");
const codexLinuxAccountSwitcherActivePath=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"account-switcher.active");
const codexLinuxAccountSwitcherHandoffPath=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"account-switcher.handoff");
const codexLinuxAccountSwitcherRemoveCompletePath=codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherConfigDir,"account-switcher.remove-complete");
const codexLinuxAccountSwitcherBaseCodexHome=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME||process.env.CODEX_HOME||codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherHome,".codex");
const codexLinuxAccountSwitcherIdPattern=/^[a-z0-9][a-z0-9._-]{0,63}$/;
function codexLinuxAccountSwitcherId(value){
  return typeof value==="string"&&value!=="."&&value!==".."&&codexLinuxAccountSwitcherIdPattern.test(value)?value:null;
}
function codexLinuxAccountSwitcherNewId(value){const id=typeof value==="string"?value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64):"";return codexLinuxAccountSwitcherId(id)}
function codexLinuxAccountSwitcherProfilePath(id){const valid=codexLinuxAccountSwitcherId(id);if(!valid)throw Error("Invalid account profile id");const root=codexLinuxAccountSwitcherPath.resolve(codexLinuxAccountSwitcherDataHome,"codex-desktop","account-profiles"),candidate=codexLinuxAccountSwitcherPath.resolve(root,valid);if(candidate!==root&&!candidate.startsWith(root+codexLinuxAccountSwitcherPath.sep))throw Error("Account profile path escaped its managed root");return candidate}
function codexLinuxAccountSwitcherRead(){
  try{const value=JSON.parse(codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherConfigPath,"utf8"));if(!value||!Array.isArray(value.profiles))throw Error("invalid registry");const ids=new Set;for(const profile of value.profiles){if(!profile||!codexLinuxAccountSwitcherId(profile.id)||!codexLinuxAccountSwitcherId(profile.contextId||"default")||ids.has(profile.id))throw Error("invalid or duplicate profile id in registry");ids.add(profile.id)}if(value.previousProfileId!=null&&!codexLinuxAccountSwitcherId(value.previousProfileId))throw Error("invalid previous profile id in registry");return value}catch(error){if(error?.code==="ENOENT")return {version:1,profiles:[]};throw error}
}
function codexLinuxAccountSwitcherSyncPath(file){const fd=codexLinuxAccountSwitcherFs.openSync(file,"r");try{codexLinuxAccountSwitcherFs.fsyncSync(fd)}finally{codexLinuxAccountSwitcherFs.closeSync(fd)}}
function codexLinuxAccountSwitcherWriteAtomic(file,content){const directory=codexLinuxAccountSwitcherPath.dirname(file);codexLinuxAccountSwitcherFs.mkdirSync(directory,{recursive:true,mode:448});const temporary=file+".tmp."+process.pid+"."+Date.now();codexLinuxAccountSwitcherFs.writeFileSync(temporary,content,{encoding:"utf8",mode:384});codexLinuxAccountSwitcherSyncPath(temporary);codexLinuxAccountSwitcherFs.renameSync(temporary,file);codexLinuxAccountSwitcherSyncPath(directory)}
function codexLinuxAccountSwitcherRemoveDurably(file){if(!codexLinuxAccountSwitcherFs.existsSync(file))return;codexLinuxAccountSwitcherFs.rmSync(file,{force:true});codexLinuxAccountSwitcherSyncPath(codexLinuxAccountSwitcherPath.dirname(file))}
function codexLinuxAccountSwitcherWrite(value){codexLinuxAccountSwitcherWriteAtomic(codexLinuxAccountSwitcherConfigPath,JSON.stringify(value,null,2)+"\n")}
function codexLinuxAccountSwitcherResolveExecutable(name){
  const candidates=[];for(const directory of String(process.env.PATH||"").split(codexLinuxAccountSwitcherPath.delimiter)){if(directory)candidates.push(codexLinuxAccountSwitcherPath.resolve(directory,name))}for(const directory of ["/usr/bin","/bin"]){const candidate=codexLinuxAccountSwitcherPath.join(directory,name);if(!candidates.includes(candidate))candidates.push(candidate)}for(const candidate of candidates){try{codexLinuxAccountSwitcherFs.accessSync(candidate,codexLinuxAccountSwitcherFs.constants.X_OK);if(codexLinuxAccountSwitcherFs.statSync(candidate).isFile())return candidate}catch{}}throw Error("Account-switcher requires "+name)
}
function codexLinuxAccountSwitcherWithLock(mutator){
  codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherConfigDir,{recursive:true,mode:448});
  const lock=codexLinuxAccountSwitcherConfigPath+".lock",flock=codexLinuxAccountSwitcherResolveExecutable("flock"),shell=codexLinuxAccountSwitcherResolveExecutable("sh"),lockFd=codexLinuxAccountSwitcherFs.openSync(lock,"a",384);codexLinuxAccountSwitcherFs.fchmodSync(lockFd,384);
  return new Promise((resolve,reject)=>{let child,stdout="",stderr="",result,ready=false,operationDone=false,processDone=false,exitCode=null,failure=null;try{child=codexLinuxAccountSwitcherChildProcess.spawn(flock,["-x","-w","5","/proc/self/fd/3",shell,"-c","printf 'ready\\n'; cat >/dev/null"],{stdio:["pipe","pipe","pipe",lockFd]})}finally{codexLinuxAccountSwitcherFs.closeSync(lockFd)}const timer=setTimeout(()=>{if(!ready){failure=Error("Timed out waiting for account-switcher registry lock");operationDone=true;child.kill()}},5500),settle=()=>{if(!operationDone||!processDone)return;if(failure)reject(failure);else if(exitCode===0)resolve(result);else reject(Error(stderr.trim()||"Account-switcher registry lock failed"))};child.stderr.on("data",(chunk)=>{stderr=(stderr+String(chunk)).slice(-4096)});child.on("error",(error)=>{clearTimeout(timer);failure=error;operationDone=true;processDone=true;settle()});child.on("close",(code)=>{clearTimeout(timer);exitCode=code;processDone=true;if(!ready){failure=Error(stderr.trim()||"Timed out waiting for account-switcher registry lock");operationDone=true}settle()});child.stdout.on("data",(chunk)=>{if(ready)return;stdout+=String(chunk);if(!stdout.includes("ready\n"))return;ready=true;clearTimeout(timer);Promise.resolve().then(()=>{const value=codexLinuxAccountSwitcherRead();result=mutator(value);codexLinuxAccountSwitcherWrite(value)}).then(()=>{operationDone=true;child.stdin.end();settle()},(error)=>{failure=error;operationDone=true;child.stdin.end();settle()})})})
}
function codexLinuxAccountSwitcherWriteActive(profile){codexLinuxAccountSwitcherWriteAtomic(codexLinuxAccountSwitcherActivePath,[profile.id,profile.contextMode||"isolated",profile.contextId||"default"].join("\n")+"\n")}
function codexLinuxAccountSwitcherProcessIdentity(pid=process.pid){const raw=codexLinuxAccountSwitcherFs.readFileSync("/proc/"+pid+"/stat","utf8"),fields=raw.slice(raw.lastIndexOf(") ")+2).trim().split(/\s+/),start=fields[19],boot=codexLinuxAccountSwitcherFs.readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();if(!/^[1-9][0-9]*$/.test(String(pid))||!/^[0-9]+$/.test(start)||!/^[0-9a-f-]+$/.test(boot))throw Error("Could not read the account-switcher process identity");return{pid,start,boot}}
function codexLinuxAccountSwitcherWriteHandoff(source,target,removeId,targetPrevious=target){const owner=codexLinuxAccountSwitcherProcessIdentity(process.ppid);const lines=["version=1","phase=requested","owner_pid="+owner.pid,"owner_start="+owner.start,"owner_boot="+owner.boot,"nonce="+Date.now().toString(36)+"-"+process.pid,"from_id="+(source?.id||"default"),"from_mode="+(source?.contextMode||"isolated"),"from_context="+(source?.contextId||"default"),"target_id="+target.id,"target_mode="+(target.contextMode||"isolated"),"target_context="+(target.contextId||"default"),"target_previous_mode="+(targetPrevious?.contextMode||"isolated"),"target_previous_context="+(targetPrevious?.contextId||"default")];if(removeId)lines.push("remove_id="+removeId);codexLinuxAccountSwitcherWriteAtomic(codexLinuxAccountSwitcherHandoffPath,lines.join("\n")+"\n")}
async function codexLinuxAccountSwitcherRecoverFailedHandoff(){
  let record;
  try{record={};for(const line of codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherHandoffPath,"utf8").split("\n")){const separator=line.indexOf("=");if(separator<=0)continue;const key=line.slice(0,separator);if(/^[a-z_]+$/.test(key))record[key]=line.slice(separator+1)}}catch(error){if(error?.code!=="ENOENT")console.warn("WARN: account-switcher failed-handoff recovery could not read metadata: "+error.message);return}
  if(record.version!=="1"||record.phase!=="failed")return;
  const targetId=codexLinuxAccountSwitcherId(record.target_id),targetMode=record.target_mode,targetContext=codexLinuxAccountSwitcherId(record.target_context),previousMode=record.target_previous_mode,previousContext=codexLinuxAccountSwitcherId(record.target_previous_context);
  if(!targetId||(targetMode!=="isolated"&&targetMode!=="shared-local")||!targetContext||(previousMode!=="isolated"&&previousMode!=="shared-local")||!previousContext){console.warn("WARN: account-switcher ignored invalid failed-handoff metadata");return}
  try{await codexLinuxAccountSwitcherWithLock((latest)=>{const profile=latest.profiles.find((entry)=>entry&&entry.id===targetId);if(profile&&(profile.contextMode||"isolated")===targetMode&&(profile.contextId||"default")===targetContext){profile.contextMode=previousMode;profile.contextId=previousContext}});codexLinuxAccountSwitcherRemoveDurably(codexLinuxAccountSwitcherHandoffPath)}catch(error){console.warn("WARN: account-switcher failed-handoff recovery could not restore registry: "+error.message)}
}
const codexLinuxAccountSwitcherFailedHandoffRecovery=codexLinuxAccountSwitcherRecoverFailedHandoff();
function codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry){
  if(typeof registry.keepLocalProjectsThreads==="boolean")return registry.keepLocalProjectsThreads;
  const activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",active=registry.profiles.find((entry)=>entry&&entry.id===activeId);
  return active?.contextMode==="shared-local";
}
function codexLinuxAccountSwitcherSetKeepLocalProjectsThreads(registry,enabled){
  registry.keepLocalProjectsThreads=enabled===true;
  if(registry.keepLocalProjectsThreads&&!codexLinuxAccountSwitcherId(registry.sharedContextId))registry.sharedContextId="shared-"+Date.now().toString(36);
  const activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",active=registry.profiles.find((entry)=>entry&&entry.id===activeId);
  if(active){active.contextMode=registry.keepLocalProjectsThreads?"shared-local":"isolated";active.contextId=registry.keepLocalProjectsThreads?(codexLinuxAccountSwitcherId(registry.sharedContextId)||"default"):"default"}
  return active||null;
}
function codexLinuxAccountSwitcherDefault(registry){
  let profile=registry.profiles.find((entry)=>entry&&entry.id==="default");
  if(profile==null){profile={id:"default",name:"Current account",contextMode:"isolated",contextId:"default",createdAt:new Date().toISOString()};registry.profiles.unshift(profile)}
  return profile;
}
function codexLinuxAccountSwitcherDecodeJwtPayload(token){
  try{const part=String(token||"").split(".")[1];if(!part)return null;return JSON.parse(Buffer.from(part.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"))}catch{return null}
}
function codexLinuxAccountSwitcherProfileCodexHome(profile){return profile.id==="default"?codexLinuxAccountSwitcherBaseCodexHome:codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherProfilePath(profile.id),"codex")}
function codexLinuxAccountSwitcherReadAuth(profile){
  try{return JSON.parse(codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherProfileCodexHome(profile),"auth.json"),"utf8"))}catch{return null}
}
function codexLinuxAccountSwitcherHasAuth(profile){const token=codexLinuxAccountSwitcherReadAuth(profile)?.tokens?.access_token;return typeof token==="string"&&token.length>0}
function codexLinuxAccountSwitcherAuthPath(profile){return codexLinuxAccountSwitcherPath.join(codexLinuxAccountSwitcherProfileCodexHome(profile),"auth.json")}
function codexLinuxAccountSwitcherLoginPending(profile){const until=Date.parse(profile?.loginPendingUntil||"");return Number.isFinite(until)&&until>Date.now()}
function codexLinuxAccountSwitcherUsage(accessToken,accountId){
  return new Promise((resolve)=>{
    if(typeof accessToken!=="string"||accessToken.length===0){resolve(null);return}
    const request=codexLinuxAccountSwitcherHttps.request("https://chatgpt.com/backend-api/wham/usage",{method:"GET",headers:{Authorization:"Bearer "+accessToken,"chatgpt-account-id":typeof accountId==="string"?accountId:"","OAI-App-Brand":"codex"}},(response)=>{
      let body="";response.setEncoding("utf8");response.on("data",(chunk)=>{if(body.length<1048576)body+=chunk});response.on("end",()=>{try{if(response.statusCode<200||response.statusCode>=300){resolve(null);return}const value=JSON.parse(body),percent=value?.rate_limit?.primary_window?.used_percent,email=typeof value?.email==="string"?value.email.trim():null;resolve({email:email||null,usagePercent:Number.isFinite(percent)?Math.max(0,Math.min(100,Math.round(percent))):null})}catch{resolve(null)}})
    });
    request.setTimeout(5000,()=>{request.destroy();resolve(null)});request.on("error",()=>resolve(null));request.end();
  })
}
function codexLinuxAccountSwitcherCachedDetails(profile){
  const auth=codexLinuxAccountSwitcherReadAuth(profile),tokens=auth?.tokens||{},claims=codexLinuxAccountSwitcherDecodeJwtPayload(tokens.id_token),cachedEmail=typeof profile.email==="string"?profile.email:null,cachedUsage=Number.isFinite(profile.usagePercent)?profile.usagePercent:null;
  return{email:cachedEmail|| (typeof claims?.email==="string"?claims.email:null),usagePercent:cachedUsage,usageUpdatedAt:typeof profile.usageUpdatedAt==="string"?profile.usageUpdatedAt:null,tokens};
}
async function codexLinuxAccountSwitcherDetails(profile){
  const fallback=codexLinuxAccountSwitcherCachedDetails(profile),tokens=fallback.tokens;
  const live=await codexLinuxAccountSwitcherUsage(tokens.access_token,tokens.account_id);
  if(live==null)return fallback;
  return{email:live.email||fallback.email,usagePercent:live.usagePercent==null?fallback.usagePercent:live.usagePercent,usageUpdatedAt:live.usagePercent==null?fallback.usageUpdatedAt:new Date().toISOString()}
}
function codexLinuxAccountSwitcherPublic(profile,details={}){const signedIn=codexLinuxAccountSwitcherHasAuth(profile),usagePercent=Number.isFinite(details.usagePercent)?details.usagePercent:Number.isFinite(profile.usagePercent)?profile.usagePercent:null;return{id:profile.id,name:profile.name,login:details.email||profile.email||null,signedIn,removable:profile.id!=="default"&&!signedIn,usagePercent,usageUpdatedAt:details.usageUpdatedAt||profile.usageUpdatedAt||null,contextMode:profile.contextMode||"isolated",contextId:profile.contextId||"default"}}
function codexLinuxAccountSwitcherProfileInUse(profile){const root=codexLinuxAccountSwitcherProfilePath(profile.id),userData=codexLinuxAccountSwitcherPath.join(root,"electron");let entries=[];try{entries=codexLinuxAccountSwitcherFs.readdirSync("/proc",{withFileTypes:true})}catch{return false}for(const entry of entries){if(!entry.isDirectory()||!/^[0-9]+$/.test(entry.name))continue;const processRoot=codexLinuxAccountSwitcherPath.join("/proc",entry.name);try{const args=codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherPath.join(processRoot,"cmdline")).toString().split("\0");if(args.includes("--user-data-dir="+userData))return true}catch{}let fds=[];try{fds=codexLinuxAccountSwitcherFs.readdirSync(codexLinuxAccountSwitcherPath.join(processRoot,"fd"))}catch{}for(const fd of fds){try{const link=codexLinuxAccountSwitcherFs.readlinkSync(codexLinuxAccountSwitcherPath.join(processRoot,"fd",fd));if(link===root||link.startsWith(root+codexLinuxAccountSwitcherPath.sep))return true}catch{}}}return false}
function codexLinuxAccountSwitcherDeleteProfile(profile){if(profile.id==="default")throw Error("The default account profile cannot be removed");if(codexLinuxAccountSwitcherProfileInUse(profile))throw Error("Account profile is still in use");codexLinuxAccountSwitcherFs.rmSync(codexLinuxAccountSwitcherProfilePath(profile.id),{recursive:true,force:true})}
async function codexLinuxAccountSwitcherFinalizeRemoval(){let id;try{id=codexLinuxAccountSwitcherId(codexLinuxAccountSwitcherFs.readFileSync(codexLinuxAccountSwitcherRemoveCompletePath,"utf8").trim())}catch(error){if(error?.code!=="ENOENT")console.warn("WARN: account-switcher removal recovery failed: "+error.message);return}if(!id||id==="default"){console.warn("WARN: account-switcher ignored invalid removal completion");return}try{await codexLinuxAccountSwitcherWithLock((latest)=>{latest.profiles=latest.profiles.filter((entry)=>entry&&entry.id!==id);if(latest.previousProfileId===id)delete latest.previousProfileId});codexLinuxAccountSwitcherRemoveDurably(codexLinuxAccountSwitcherRemoveCompletePath)}catch(error){console.warn("WARN: account-switcher could not finalize profile removal: "+error.message)}}
async function codexLinuxAccountSwitcherArmRemovalRecovery(){await codexLinuxAccountSwitcherFailedHandoffRecovery;await codexLinuxAccountSwitcherFinalizeRemoval();codexLinuxAccountSwitcherFs.watchFile(codexLinuxAccountSwitcherRemoveCompletePath,{interval:250},codexLinuxAccountSwitcherFinalizeRemoval);l.app?.once?.("before-quit",()=>codexLinuxAccountSwitcherFs.unwatchFile(codexLinuxAccountSwitcherRemoveCompletePath,codexLinuxAccountSwitcherFinalizeRemoval))}
function codexLinuxAccountSwitcherSignalReady(){const ready=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE;if(!ready)return;try{codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherPath.dirname(ready),{recursive:true,mode:448});codexLinuxAccountSwitcherFs.writeFileSync(ready,String(process.pid)+"\n",{encoding:"utf8",mode:384})}catch(error){console.warn("WARN: account-switcher readiness signal failed: "+error.message)}}
if(process.env.CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE&&l.app?.whenReady)l.app.whenReady().then(codexLinuxAccountSwitcherSignalReady).catch(()=>{});
if(l.app?.whenReady)l.app.whenReady().then(codexLinuxAccountSwitcherArmRemovalRecovery).catch(()=>{});
function codexLinuxAccountSwitcherFind(registry,id){const profile=registry.profiles.find((entry)=>entry&&entry.id===id);if(profile==null)throw Error("Unknown account profile");return profile}
function codexLinuxAccountSwitcherEnvironment(profile){
  const environment={...process.env};
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME=codexLinuxAccountSwitcherBaseCodexHome;
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=profile.id;
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=profile.contextMode||"isolated";
  environment.CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=profile.contextId||"default";
  if(profile.id!=="default"){const root=codexLinuxAccountSwitcherProfilePath(profile.id);codexLinuxAccountSwitcherFs.mkdirSync(root,{recursive:true,mode:448});environment.CODEX_HOME=codexLinuxAccountSwitcherPath.join(root,"codex");environment.CODEX_ELECTRON_USER_DATA_PATH=codexLinuxAccountSwitcherPath.join(root,"electron")}
  return environment;
}
function codexLinuxAccountSwitcherRelaunch(profile,source,removeId,targetPrevious=profile){
  codexLinuxAccountSwitcherWriteHandoff(source,profile,removeId,targetPrevious);
  try{codexLinuxAccountSwitcherWriteActive(profile)}catch(error){codexLinuxAccountSwitcherRemoveDurably(codexLinuxAccountSwitcherHandoffPath);throw Error("Account handoff could not persist its target: "+error.message)}
  try{l.app.quit()}catch(error){try{codexLinuxAccountSwitcherWriteActive(source)}catch{}codexLinuxAccountSwitcherRemoveDurably(codexLinuxAccountSwitcherHandoffPath);throw Error("Account handoff could not begin: "+error.message)}
  return{ok:true,restarting:true,profile:codexLinuxAccountSwitcherPublic(profile)};
}
function codexLinuxAccountSwitcherChooseAuthenticatedFallback(registry,active){
  const previous=codexLinuxAccountSwitcherId(registry.previousProfileId),eligible=(profile)=>profile&&profile.id!==active.id&&codexLinuxAccountSwitcherHasAuth(profile);
  return registry.profiles.find((profile)=>profile.id===previous&&eligible(profile))||registry.profiles.find(eligible)||null;
}
function codexLinuxAccountSwitcherArmLogoutFallback(){
  let registry;try{registry=codexLinuxAccountSwitcherRead();codexLinuxAccountSwitcherDefault(registry)}catch(error){console.warn("WARN: account-switcher logout monitor could not read registry: "+error.message);return}
  const activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",active=registry.profiles.find((profile)=>profile&&profile.id===activeId)||codexLinuxAccountSwitcherDefault(registry),authPath=codexLinuxAccountSwitcherAuthPath(active);
  let observedAuthenticated=codexLinuxAccountSwitcherHasAuth(active),pendingTimer=null,loginDeadlineTimer=null,finished=false;
  const stop=()=>{if(finished)return;finished=true;if(pendingTimer!=null)clearTimeout(pendingTimer);if(loginDeadlineTimer!=null)clearTimeout(loginDeadlineTimer);codexLinuxAccountSwitcherFs.unwatchFile(authPath,check)};
  const fallback=async()=>{if(finished||codexLinuxAccountSwitcherHasAuth(active)){observedAuthenticated=true;return}stop();try{const outcome=await codexLinuxAccountSwitcherWithLock((latest)=>{codexLinuxAccountSwitcherDefault(latest);const source=latest.profiles.find((profile)=>profile&&profile.id===activeId)||codexLinuxAccountSwitcherDefault(latest),target=codexLinuxAccountSwitcherChooseAuthenticatedFallback(latest,source);delete source.loginPendingUntil;if(target){latest.previousProfileId=source.id;delete target.loginPendingUntil}return{source,target}});if(outcome.target){codexLinuxAccountSwitcherRelaunch(outcome.target,outcome.source);return}setTimeout(()=>{try{l.app.focus({steal:true})}catch{}},0)}catch(error){console.warn("WARN: account-switcher logout fallback failed: "+error.message)}};
  const scheduleFallback=()=>{if(finished||pendingTimer!=null)return;pendingTimer=setTimeout(()=>{pendingTimer=null;fallback()},750)};
  function check(){if(finished)return;if(codexLinuxAccountSwitcherHasAuth(active)){observedAuthenticated=true;if(pendingTimer!=null){clearTimeout(pendingTimer);pendingTimer=null}if(loginDeadlineTimer!=null){clearTimeout(loginDeadlineTimer);loginDeadlineTimer=null}codexLinuxAccountSwitcherWithLock((latest)=>{const current=latest.profiles.find((profile)=>profile&&profile.id===activeId);if(current)delete current.loginPendingUntil}).catch(()=>{});return}if(observedAuthenticated||!codexLinuxAccountSwitcherLoginPending(active))scheduleFallback()}
  codexLinuxAccountSwitcherFs.watchFile(authPath,{interval:250},check);
  l.app?.once?.("before-quit",stop);
  const loginDeadline=Date.parse(active.loginPendingUntil||"");if(!observedAuthenticated&&Number.isFinite(loginDeadline)&&loginDeadline>Date.now())loginDeadlineTimer=setTimeout(()=>{loginDeadlineTimer=null;check()},Math.min(2147483647,loginDeadline-Date.now()+1));
  check();
}
if(l.app?.whenReady)l.app.whenReady().then(()=>codexLinuxAccountSwitcherFailedHandoffRecovery).then(codexLinuxAccountSwitcherArmLogoutFallback).catch(()=>{});
l.ipcMain.handle(codexLinuxAccountSwitcherIpc,async(codexLinuxAccountSwitcherEvent,request={})=>{
  if(!be(codexLinuxAccountSwitcherEvent))throw Error("Untrusted account-switcher IPC sender");
  await codexLinuxAccountSwitcherFailedHandoffRecovery;
  const action=typeof request.action==="string"?request.action:"list";
  const registry=codexLinuxAccountSwitcherRead();
  codexLinuxAccountSwitcherDefault(registry);
  if(action==="list"){
    const details=registry.profiles.map((profile)=>codexLinuxAccountSwitcherCachedDetails(profile));
    return{profiles:registry.profiles.map((profile,index)=>codexLinuxAccountSwitcherPublic(profile,details[index])),activeProfileId:process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",keepLocalProjectsThreads:codexLinuxAccountSwitcherKeepLocalProjectsThreads(registry)}
  }
  if(action==="refresh"){
    const snapshot=registry.profiles.map((profile)=>({id:profile.id,version:JSON.stringify(profile),details:codexLinuxAccountSwitcherDetails(profile)})),details=await Promise.all(snapshot.map((entry)=>entry.details)),now=new Date().toISOString();
    return codexLinuxAccountSwitcherWithLock((latest)=>{codexLinuxAccountSwitcherDefault(latest);const byId=new Map(snapshot.map((entry,index)=>[entry.id,{version:entry.version,details:details[index]}]));for(const profile of latest.profiles){const entry=byId.get(profile.id);if(!entry||JSON.stringify(profile)!==entry.version)continue;const value=entry.details;if(value.email)profile.email=value.email;if(value.usagePercent!=null){profile.usagePercent=value.usagePercent;profile.usageUpdatedAt=value.usageUpdatedAt||now}}return{profiles:latest.profiles.map((profile)=>codexLinuxAccountSwitcherPublic(profile)),activeProfileId:process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",keepLocalProjectsThreads:codexLinuxAccountSwitcherKeepLocalProjectsThreads(latest)}})
  }
  if(action==="set-settings"){
    const outcome=await codexLinuxAccountSwitcherWithLock((latest)=>{codexLinuxAccountSwitcherDefault(latest);const activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default",sourceCurrent=latest.profiles.find((entry)=>entry&&entry.id===activeId)||codexLinuxAccountSwitcherDefault(latest),source={...sourceCurrent},active=codexLinuxAccountSwitcherSetKeepLocalProjectsThreads(latest,request.keepLocalProjectsThreads===true),changed=active&&((active.contextMode||"isolated")!==(source.contextMode||"isolated")||(active.contextId||"default")!==(source.contextId||"default"));return{active:active?{...active}:null,source,changed,keepLocalProjectsThreads:codexLinuxAccountSwitcherKeepLocalProjectsThreads(latest)}});
    if(outcome.changed)return codexLinuxAccountSwitcherRelaunch(outcome.active,outcome.source,undefined,outcome.source);
    if(outcome.active)codexLinuxAccountSwitcherWriteActive(outcome.active);
    return{ok:true,keepLocalProjectsThreads:outcome.keepLocalProjectsThreads};
  }
  if(action==="create"){
    const name=typeof request.name==="string"?request.name.trim():"";
    const id=request.id==null?codexLinuxAccountSwitcherNewId(name):codexLinuxAccountSwitcherId(request.id);
    if(!id)throw Error("Account name is required");
    return codexLinuxAccountSwitcherWithLock((latest)=>{codexLinuxAccountSwitcherDefault(latest);if(latest.profiles.some((entry)=>entry.id===id))throw Error("An account profile with that name already exists");const profile={id,name:name||id,contextMode:"isolated",contextId:"default",createdAt:new Date().toISOString()};latest.profiles.push(profile);codexLinuxAccountSwitcherFs.mkdirSync(codexLinuxAccountSwitcherProfilePath(id),{recursive:true,mode:448});return{profile:codexLinuxAccountSwitcherPublic(profile)}});
  }
  if(action==="remove"){
    const id=codexLinuxAccountSwitcherId(request.id);if(!id)throw Error("Invalid account profile id");
    const outcome=await codexLinuxAccountSwitcherWithLock((latest)=>{codexLinuxAccountSwitcherDefault(latest);const profile=codexLinuxAccountSwitcherFind(latest,id),activeId=process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default";if(profile.id==="default")throw Error("The default account profile cannot be removed");if(codexLinuxAccountSwitcherHasAuth(profile))throw Error("Sign out before removing this account profile");if(profile.id===activeId){const target=codexLinuxAccountSwitcherChooseAuthenticatedFallback(latest,profile);if(!target)throw Error("Sign in to another account before removing the active profile");return{relaunch:{target:{...target},source:{...profile},removeId:profile.id}}}codexLinuxAccountSwitcherDeleteProfile(profile);latest.profiles=latest.profiles.filter((entry)=>entry.id!==profile.id);if(latest.previousProfileId===profile.id)delete latest.previousProfileId;return{response:{ok:true,removedProfileId:profile.id}}});
    if(outcome.relaunch)return codexLinuxAccountSwitcherRelaunch(outcome.relaunch.target,outcome.relaunch.source,outcome.relaunch.removeId);
    return outcome.response;
  }
  if(action==="switch"){
    const outcome=await codexLinuxAccountSwitcherWithLock((latest)=>{codexLinuxAccountSwitcherDefault(latest);const profile=codexLinuxAccountSwitcherFind(latest,codexLinuxAccountSwitcherId(request.id)),sourceCurrent=latest.profiles.find((entry)=>entry.id===(process.env.CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE||"default"))||latest.profiles.find((entry)=>entry.id==="default"),source={...sourceCurrent},targetPrevious={...profile};if(request.contextMode!=null){if(request.contextMode!=="isolated"&&request.contextMode!=="shared-local")throw Error("Unknown account context mode");profile.contextMode=request.contextMode;profile.contextId=request.contextMode==="shared-local"?(codexLinuxAccountSwitcherId(latest.sharedContextId)||"default"):"default"}if(profile.id!==source.id)latest.previousProfileId=source.id;if(codexLinuxAccountSwitcherHasAuth(profile))delete profile.loginPendingUntil;else profile.loginPendingUntil=new Date(Date.now()+900000).toISOString();return{profile:{...profile},source,targetPrevious}});
    return codexLinuxAccountSwitcherRelaunch(outcome.profile,outcome.source,undefined,outcome.targetPrevious);
  }
  throw Error("Unknown account-switcher action");
});
})();`;

const WEBVIEW_RUNTIME = String.raw`;/*${RUNTIME_MARKER}*/(()=>{
if(window.__codexLinuxAccountSwitcherRuntime)return;
window.__codexLinuxAccountSwitcherRuntime=true;
window.codexLinuxOpenAccountSwitcher=()=>{
  const api=window.electronBridge;
  if(!api?.getLinuxAccountProfiles)return;
  let overlay=document.querySelector("[data-codex-linux-account-switcher]");
  if(!overlay){
    overlay=document.createElement("div");overlay.dataset.codexLinuxAccountSwitcher="true";
    overlay.innerHTML="<style>[data-codex-linux-account-switcher]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:13px/1.35 system-ui,sans-serif;color:var(--text-primary,#fff)}.als-card{width:360px;max-width:calc(100vw - 32px);border:1px solid var(--border-medium,rgba(255,255,255,.16));border-radius:14px;background:var(--surface-primary,#242424);box-shadow:0 18px 60px rgba(0,0,0,.45);padding:18px}.als-title{font-size:16px;font-weight:650}.als-copy{color:var(--text-secondary,#aaa);font-size:12px;margin:4px 0 14px}.als-list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}.als-account-row{display:flex;align-items:stretch;gap:4px}.als-account,.als-remove,.als-close,.als-add{border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.als-account{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:9px 10px;text-align:left}.als-remove{flex:none;width:32px;padding:0;text-align:center;font-size:18px;color:var(--text-secondary,#aaa)}.als-account:hover,.als-remove:hover,.als-close:hover{background:rgba(255,255,255,.1)}.als-account-active{background:rgba(255,255,255,.12)}.als-dot{width:7px;height:7px;border-radius:50%;background:#6ee7b7}.als-dot-signed-out{background:#777}.als-details{display:flex;flex:1;min-width:0;flex-direction:column}.als-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.als-meta{color:var(--text-secondary,#aaa);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.als-badge{color:var(--text-secondary,#aaa);font-size:11px}.als-rule{height:1px;background:rgba(255,255,255,.12);margin:12px 0}.als-form{display:flex;gap:6px}.als-input{min-width:0;flex:1;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:transparent;color:inherit;padding:8px}.als-add{background:#fff;color:#111;text-align:center;padding:9px 10px}.als-close{padding:9px 10px;text-align:left}.als-mode{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--text-secondary,#bbb);font-size:11px;cursor:pointer}.als-mode input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.als-switch{position:relative;flex:none;width:30px;height:17px;border-radius:10px;background:#666;transition:background .15s ease}.als-switch::after{content:\"\";position:absolute;top:3px;left:3px;width:11px;height:11px;border-radius:50%;background:#ddd;transition:transform .15s ease}.als-mode input:checked+.als-switch{background:#6ee7b7}.als-mode input:checked+.als-switch::after{transform:translateX(13px);background:#132a24}.als-mode-copy{flex:1}.als-mode-state{min-width:22px;color:var(--text-secondary,#aaa);text-align:right}.als-actions{display:flex;justify-content:flex-end;margin-top:12px}.als-error{color:#ff9b9b;font-size:11px;margin-top:7px}</style><div class=als-card role=dialog aria-modal=true><div class=als-title>Switch account</div><div class=als-copy>Choose a saved profile. Switching relaunches Codex without logging out or deleting profile data.</div><div class=als-list></div><div class=als-rule></div><form class=als-form><input class=als-input maxlength=64 placeholder=\"Add account name\"/><button class=als-add type=submit>Add</button></form><label class=als-mode><input type=checkbox aria-label=\"Keep local projects and threads\"/><span class=als-switch aria-hidden=true></span><span class=als-mode-copy>Keep the local projects/thread catalog</span><span class=als-mode-state>Off</span></label><div class=als-error aria-live=polite></div><div class=als-actions><button class=als-close type=button>Close</button></div></div>";
    document.body.append(overlay);
    overlay.querySelector(".als-close").onclick=()=>overlay.remove();
    overlay.addEventListener("click",(event)=>{if(event.target===overlay)overlay.remove()});
    overlay.querySelector("form").onsubmit=async(event)=>{event.preventDefault();const input=overlay.querySelector(".als-input"),name=input.value.trim();if(!name)return;try{const result=await api.createLinuxAccountProfile({name});await api.switchLinuxAccountProfile({id:result.profile.id,contextMode:overlay.querySelector(".als-mode input").checked?"shared-local":"isolated",contextId:"default"})}catch(error){overlay.querySelector(".als-error").textContent=error?.message||String(error)}};
  }
  const list=overlay.querySelector(".als-list"),error=overlay.querySelector(".als-error"),shared=overlay.querySelector(".als-mode input"),sharedState=overlay.querySelector(".als-mode-state"),syncSharedState=()=>{sharedState.textContent=shared.checked?"On":"Off"};
  const persistSharedState=async()=>{const requested=shared.checked;syncSharedState();try{await api.setLinuxAccountSwitcherSettings({keepLocalProjectsThreads:requested})}catch(errorValue){shared.checked=!requested;syncSharedState();error.textContent=errorValue?.message||String(errorValue)}};
  shared.onchange=persistSharedState;syncSharedState();
  list.replaceChildren();error.textContent="";
  const rows=new Map(),updateProfileRow=(button,profile)=>{const name=button.querySelector(".als-name"),meta=button.querySelector(".als-meta"),dot=button.querySelector(".als-dot"),nextName=profile.login||profile.name||profile.id,nextMeta=profile.signedIn===false?"Signed out":Number.isFinite(profile.usagePercent)?"Usage: "+profile.usagePercent+"% used":"Usage: unavailable";if(name.textContent!==nextName)name.textContent=nextName;if(meta.textContent!==nextMeta)meta.textContent=nextMeta;dot.classList.toggle("als-dot-signed-out",profile.signedIn===false)};
  const cachedRequest=api.getLinuxAccountProfiles(),refreshRequest=api.refreshLinuxAccountProfiles?.();
  cachedRequest.then((state)=>{if(!overlay.isConnected)return;shared.checked=state.keepLocalProjectsThreads===true;syncSharedState();for(const profile of state.profiles){const row=document.createElement("div"),button=document.createElement("button");row.className="als-account-row";button.type="button";button.className="als-account"+(profile.id===state.activeProfileId?" als-account-active":"");button.innerHTML="<span class=als-dot></span><span class=als-details><span class=als-name></span><span class=als-meta></span></span><span class=als-badge></span>";updateProfileRow(button,profile);button.querySelector(".als-badge").textContent=profile.id===state.activeProfileId?(profile.signedIn===false?"active · signed out":"active"):(profile.signedIn===false?"sign in":"switch");button.onclick=async()=>{if(profile.id===state.activeProfileId)return;button.disabled=true;try{await api.switchLinuxAccountProfile({id:profile.id,contextMode:shared.checked?"shared-local":"isolated",contextId:"default"})}catch(errorValue){button.disabled=false;error.textContent=errorValue?.message||String(errorValue)}};row.append(button);if(profile.removable&&api.removeLinuxAccountProfile){const remove=document.createElement("button");remove.type="button";remove.className="als-remove";remove.textContent="×";remove.setAttribute("aria-label","Remove "+(profile.login||profile.name||profile.id));remove.onclick=async()=>{remove.disabled=true;error.textContent="";try{const result=await api.removeLinuxAccountProfile({id:profile.id});if(result?.restarting)return;row.remove();rows.delete(profile.id);codexLinuxSyncSignedOutSwitcher()}catch(errorValue){remove.disabled=false;error.textContent=errorValue?.message||String(errorValue)}};row.append(remove)}rows.set(profile.id,{row,button});list.append(row)}}).catch((errorValue)=>{error.textContent=errorValue?.message||String(errorValue)});
  if(refreshRequest)refreshRequest.then((state)=>cachedRequest.then(()=>{if(!overlay.isConnected)return;for(const profile of state.profiles){const entry=rows.get(profile.id);if(entry)updateProfileRow(entry.button,profile)}})).catch(()=>{});
};
const codexLinuxSyncSignedOutSwitcher=async()=>{
  const api=window.electronBridge;if(!api?.getLinuxAccountProfiles)return;
  try{const state=await api.getLinuxAccountProfiles(),active=state.profiles.find((profile)=>profile.id===state.activeProfileId),show=active?.signedIn===false&&state.profiles.length>1;let button=document.querySelector("[data-codex-linux-signed-out-switcher]");if(!show){button?.remove();return}if(button)return;button=document.createElement("button");button.type="button";button.dataset.codexLinuxSignedOutSwitcher="true";button.textContent="Switch account";button.setAttribute("aria-label","Switch account");button.style.cssText="position:fixed;left:16px;bottom:16px;z-index:2147482999;border:1px solid rgba(0,0,0,.18);border-radius:9px;background:#fff;color:#202020;box-shadow:0 4px 18px rgba(0,0,0,.14);padding:9px 12px;font:600 13px/1.2 system-ui,sans-serif;cursor:pointer";button.onclick=()=>window.codexLinuxOpenAccountSwitcher?.();document.body.append(button)}catch{}
};
codexLinuxSyncSignedOutSwitcher();setInterval(codexLinuxSyncSignedOutSwitcher,2000);
})();`;

function replaceOnce(source, needle, replacement, description) {
  const count = source.split(needle).length - 1;
  if (count === 1) return source.replace(needle, replacement);
  console.warn(`WARN: Expected one ${description}, found ${count} - skipping account-switcher patch`);
  return source;
}

function applyMainBundlePatch(source) {
  if (source.includes(MAIN_MARKER)) return source;
  const anchorPattern = /([A-Za-z_$][\w$]*)=e=>[A-Za-z_$][\w$]*\.isTrustedIpcSender\(e\.sender,e\.senderFrame\?\?null\);/g;
  const matches = [...source.matchAll(anchorPattern)];
  if (matches.length !== 1) {
    console.warn(`WARN: Expected one trusted Electron IPC anchor, found ${matches.length} - skipping account-switcher patch`);
    return source;
  }
  const [needle, trustedPredicate] = matches[0];
  const runtime = trustedPredicate === "be"
    ? MAIN_RUNTIME
    : MAIN_RUNTIME.replace(/\bbe\(/g, `${trustedPredicate}(`);
  const offset = matches[0].index + needle.length;
  return source.slice(0, offset) + runtime + source.slice(offset);
}

function applyPreloadPatch(extractedDir) {
  const target = path.join(extractedDir, ".vite", "build", "preload.js");
  if (!fs.existsSync(target)) {
    console.warn(`WARN: Could not find ${target} - skipping account-switcher preload bridge`);
    return { matched: 0, changed: 0 };
  }
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(PRELOAD_MARKER)) return { matched: 1, changed: 0 };
  const exposes = [...source.matchAll(/([A-Za-z_$][\w$]*)\.contextBridge\.exposeInMainWorld\(`electronBridge`,([A-Za-z_$][\w$]*)\)/g)];
  if (exposes.length !== 1) {
    console.warn(`WARN: Expected one Electron preload bridge exposure, found ${exposes.length} - skipping account-switcher patch`);
    return { matched: exposes.length, changed: 0 };
  }
  const [, electron, bridge] = exposes[0];
  const declaration = `${bridge}={`;
  const declarationIndex = source.lastIndexOf(declaration, exposes[0].index);
  const bridgeEnd = source.lastIndexOf(`};${electron}.ipcRenderer.on`, exposes[0].index);
  const matched = declarationIndex >= 0 && bridgeEnd > declarationIndex ? 1 : 0;
  if (matched !== 1) {
    console.warn(`WARN: Expected one path-contained Electron preload bridge object, found ${matched} - skipping account-switcher patch`);
    return { matched, changed: 0 };
  }
  const methods = `,getLinuxAccountProfiles:()=>${electron}.ipcRenderer.invoke("codex_linux_account_switcher",{action:"list"}),refreshLinuxAccountProfiles:()=>${electron}.ipcRenderer.invoke("codex_linux_account_switcher",{action:"refresh"}),createLinuxAccountProfile:t=>${electron}.ipcRenderer.invoke("codex_linux_account_switcher",{action:"create",...t}),removeLinuxAccountProfile:t=>${electron}.ipcRenderer.invoke("codex_linux_account_switcher",{action:"remove",...t}),setLinuxAccountSwitcherSettings:t=>${electron}.ipcRenderer.invoke("codex_linux_account_switcher",{action:"set-settings",...t}),switchLinuxAccountProfile:t=>${electron}.ipcRenderer.invoke("codex_linux_account_switcher",{action:"switch",...t})/*${PRELOAD_MARKER}*/`;
  const patched = source.slice(0, bridgeEnd) + methods + source.slice(bridgeEnd);
  if (patched !== source) fs.writeFileSync(target, patched, "utf8");
  return { matched, changed: patched === source ? 0 : 1 };
}

function applyProfileMenuPatch(source) {
  if (source.includes(MENU_MARKER)) return source;
  const containerAnchor = "className:`flex w-full min-w-0 flex-col`,children:[";
  const containerCount = source.split(containerAnchor).length - 1;
  if (containerCount !== 1) return applyCompiledProfileMenuPatch(source);

  const containerStart = source.indexOf(containerAnchor);
  const nearbyStart = Math.max(0, containerStart - 1_500);
  const nearby = source.slice(nearbyStart, containerStart);
  const logoutPattern = /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{[^{}]{0,300}children:\(0,\1\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`codex\.profileDropdown\.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`\}\)\}\)/g;
  const logoutMatches = [...nearby.matchAll(logoutPattern)];
  if (logoutMatches.length !== 1) {
    console.warn(`WARN: Expected one semantic profile menu logout anchor, found ${logoutMatches.length} - skipping account-switcher patch`);
    return source;
  }

  const [, jsxRuntime, menuItem, message] = logoutMatches[0];
  const childrenStart = containerStart + containerAnchor.length;
  const childrenTail = source.slice(childrenStart, childrenStart + 500);
  const childrenMatch = childrenTail.match(/^([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)\]\}\)/);
  if (childrenMatch == null) {
    console.warn("WARN: Expected one path-contained profile menu children anchor, found 0 - skipping account-switcher patch");
    return source;
  }

  const needle = `${containerAnchor}${childrenMatch[0]}`;
  const switchItem = `(0,${jsxRuntime}.jsx)(${menuItem},{onClick:()=>window.codexLinuxOpenAccountSwitcher?.(),children:(0,${jsxRuntime}.jsx)(${message},{id:\`codex.profileDropdown.switchAccount\`,defaultMessage:\`Switch account\`,description:\`Menu item to switch between local Codex account profiles\`})})`;
  const replacement = `${containerAnchor}${childrenMatch[1]},${switchItem}]})/*${MENU_MARKER}*/`;
  const patched = replaceOnce(source, needle, replacement, "path-contained profile menu children anchor");
  // The extracted webview bundle currently ends with a source-map comment. A
  // leading newline is required so the runtime is not swallowed by that
  // comment and its `return` statements remain inside the IIFE.
  return patched === source ? source : patched + "\n" + WEBVIEW_RUNTIME;
}

function applyCompiledProfileMenuPatch(source) {
  const logoutId = "id:`codex.profileDropdown.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`";
  const logoutIndex = source.indexOf(logoutId);
  if (logoutIndex < 0 || source.indexOf(logoutId, logoutIndex + 1) >= 0) {
    console.warn("WARN: Expected one compiled profile menu logout anchor - skipping account-switcher patch");
    return source;
  }
  const nearbyStart = Math.max(0, logoutIndex - 700);
  const nearby = source.slice(nearbyStart, logoutIndex + logoutId.length);
  const logoutPattern = /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{[^{}]{0,500}children:\(0,\1\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`codex\.profileDropdown\.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`\}\)\}\)/g;
  const matches = [...nearby.matchAll(logoutPattern)];
  if (matches.length !== 1) {
    console.warn(`WARN: Expected one compiled semantic profile menu logout anchor, found ${matches.length} - skipping account-switcher patch`);
    return source;
  }
  const [, jsxRuntime, menuItem, message] = matches[0];
  const assignments = [...nearby.slice(0, matches[0].index).matchAll(/let ([A-Za-z_$][\w$]*);/g)];
  if (assignments.length === 0) {
    console.warn("WARN: Expected one compiled logout assignment - skipping account-switcher patch");
    return source;
  }
  const logoutVariable = assignments.at(-1)[1];
  const tail = source.slice(logoutIndex + logoutId.length, logoutIndex + logoutId.length + 2_000);
  const childrenMatches = [...tail.matchAll(/children:\[([A-Za-z_$][\w$]*(?:,(?:[A-Za-z_$][\w$]*|null))*)\]/g)]
    .filter((match) => match[1].split(",").includes(logoutVariable));
  if (childrenMatches.length !== 1) {
    console.warn(`WARN: Expected one compiled path-contained profile menu children anchor, found ${childrenMatches.length} - skipping account-switcher patch`);
    return source;
  }
  const switchItem = `(0,${jsxRuntime}.jsx)(${menuItem},{onClick:()=>window.codexLinuxOpenAccountSwitcher?.(),children:(0,${jsxRuntime}.jsx)(${message},{id:\`codex.profileDropdown.switchAccount\`,defaultMessage:\`Switch account\`,description:\`Menu item to switch between local Codex account profiles\`})})`;
  const match = childrenMatches[0];
  const offset = logoutIndex + logoutId.length + match.index;
  const replacement = `children:[${match[1]},${switchItem}]/*${MENU_MARKER}*/`;
  return source.slice(0, offset) + replacement + source.slice(offset + match[0].length) + "\n" + WEBVIEW_RUNTIME;
}

function patchPreload(extractedDir) {
  const result = applyPreloadPatch(extractedDir);
  return { changed: result.changed === 1, ...result };
}

module.exports = {
  MAIN_MARKER,
  PRELOAD_MARKER,
  MENU_MARKER,
  RUNTIME_MARKER,
  applyMainBundlePatch,
  applyPreloadPatch,
  applyProfileMenuPatch,
  descriptors: [
    mainBundlePatch({ id: "main-profile-ipc", order: 29_100, ciPolicy: "opt-in", apply: applyMainBundlePatch }),
    extractedAppPatch({
      id: "preload-profile-bridge",
      phase: "extracted-app:pre-webview",
      order: 29_110,
      ciPolicy: "opt-in",
      apply: patchPreload,
      status: (result, warnings) => result?.matched !== 1
        ? { status: "skipped-optional", reason: warnings[0] || "preload bridge not found" }
        : result.changed ? "applied" : "already-applied",
    }),
    webviewAssetPatch({
      id: "account-switcher-ui",
      order: 29_120,
      ciPolicy: "opt-in",
      pattern: /^app-(?:initial|primary)-[^.]+\.js$/,
      assetMatch: (source) => source.includes("codex.profileDropdown.logOut") && source.includes("className:`flex w-full min-w-0 flex-col"),
      missingDescription: "current profile-menu webview bundle",
      skipDescription: "account-switcher menu item",
      apply: applyProfileMenuPatch,
    }),
  ],
};
