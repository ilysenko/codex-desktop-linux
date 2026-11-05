"use strict";

const { findMatchingBrace } = require("../../lib/minified-js.js");

// Independent reduced current-CJS fixture with the published startup/request
// pair and the request-owned anonymous loader. The spawn collaborator is inert.
const SHELL_ENVIRONMENT_FIXTURE = [
  'exports.ids=[133],exports.modules={66439(e,t,r){"use strict";',
  'r.d(t,{startup:()=>startup,request:()=>request});',
  'async function startup(){return request({caller:"startup",retryFailed:!1})}',
  'async function request({caller:caller="startup",retryFailed:retry=!0,timeoutMs:timeout=5e3}={}){',
  'if(cached?.status==="loaded"||null!=cached&&!retry)return {...cached,caller,resultSource:"cache"};',
  'if(null!=pending&&null!=pendingTimeout&&pendingTimeout>=timeout)return pending.then(value=>({...value,caller}));',
  'let result=async function(caller,timeout){let started=Date.now();electron.app.isPackaged||(clean(process.env),listeners.forEach(callback=>callback()));',
  'let abort=new AbortController,timer=null,value=await Promise.race([(0,shell.MN)({interactive:!0,extraEnv:{[shell.$z]:"1"},signal:abort.signal}).then(userEnv=>({status:"loaded",userEnv})).catch(error=>({status:"failed",error})),',
  'new Promise(resolve=>{(timer=setTimeout(()=>{abort.abort(),resolve({status:"timed_out"})},timeout)).unref()})]).finally(()=>{null!=timer&&clearTimeout(timer)});',
  'if("loaded"===value.status)return Object.assign(process.env,value.userEnv),null!=preservedHome&&(process.env.CODEX_HOME=preservedHome),electron.app.isPackaged||clean(process.env),listeners.forEach(callback=>callback()),{status:"loaded",path:process.env.PATH??null,...metadata(started,caller,timeout)};',
  'let detail="timed_out"===value.status?`Timed out after ${timeout}ms.`:value.error instanceof Error?value.error.message:String(value.error);',
  'return shell.getLogger().warning("Failed to load shell env",{safe:{caller,durationMs:Date.now()-started,pathEntryCount:countPath(process.env.PATH??null),resultSource:"load",status:value.status,timeoutMs:timeout},sensitive:{detail,path:process.env.PATH??null}}),',
  '{status:value.status,detail,path:process.env.PATH??null,...metadata(started,caller,timeout)}}(caller,timeout);',
  'pending=result,pendingTimeout=timeout;try{let value=await result;return cached=value,value}finally{pending===result&&(pending=null,pendingTimeout=null)}}',
  '}};',
].join("");

function startupFunctions(source) {
  const request = [...source.matchAll(/async function ([\w$]+)\(\{caller:([\w$]+)="startup",retryFailed:([\w$]+)=!0,timeoutMs:([\w$]+)=5e3\}=\{\}\)\{/gu)];
  if (request.length !== 1) throw new Error("Expected one actual request function");
  const [head] = request;
  const open = head.index + head[0].length - 1;
  const requestText = source.slice(head.index, findMatchingBrace(source, open) + 1);
  const startup = [...source.matchAll(new RegExp(`async function ([\\w$]+)\\(\\)\\{return ${head[1]}\\(\\{caller:"startup",retryFailed:!1\\}\\)\\}`, "gu"))];
  if (startup.length !== 1) throw new Error("Expected one actual startup caller");
  return { requestText, startupText: startup[0][0], requestName: head[1], startupName: startup[0][1] };
}

module.exports = { SHELL_ENVIRONMENT_FIXTURE, startupFunctions };
