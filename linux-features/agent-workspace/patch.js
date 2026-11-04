"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  findCodexRequestWebviewAsset,
  listWebviewScriptAssets,
} = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const SETTINGS_ASSET = "agent-workspaces-linux.js";
const SETTINGS_SLUG = "agent-workspaces";
const SETTINGS_COMMAND_KEY = "codex-linux-agent-workspace-command";
const SETTINGS_PERMISSIONS_KEY = "codex-linux-agent-workspace-permissions";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

// Since 26.1029 the desktop main process no longer serves webview
// `vscode://codex/<method>` fetches from a handler map: the message handler
// forwards every `fetch` message to the authenticated fetch wrapper, which only
// keeps the dictation route. Agent Workspaces answers its own methods in that
// `case"fetch"` clause, before the fetch wrapper, with the same
// `fetch-response` message the webview request client waits for.
const GLOBAL_STATE_GET_METHOD = "linux-agent-workspace-get-global-state";
const GLOBAL_STATE_SET_METHOD = "linux-agent-workspace-set-global-state";
const FETCH_ROUTE_MARKER = "/*codex-linux-agent-workspace-route*/";
const HANDLERS_HELPER = "function codexLinuxAgentWorkspaceHandlers(";
const FETCH_HELPER = "async function codexLinuxAgentWorkspaceFetch(";
const FETCH_CLAUSE =
  /await this\.fetchWrapper\.handleRequest\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\);break;case"cancel-fetch":/g;

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function globalStateHandlers() {
  const allowed = `${JSON.stringify([SETTINGS_COMMAND_KEY, SETTINGS_PERMISSIONS_KEY])}.includes(k)`;
  return (
    `"${GLOBAL_STATE_GET_METHOD}":async({key,params}={})=>{let k=key??params?.key;if(!${allowed})throw Error("Unsupported global-state key");return{value:this.globalState.get(k)}},` +
    `"${GLOBAL_STATE_SET_METHOD}":async({key,value,params}={})=>{let k=key??params?.key,v=value??params?.value;if(!${allowed})throw Error("Unsupported global-state key");this.globalState.set(k,v);return{success:!0}},`
  );
}

const NODE_MODULE_EXPRESSIONS = Object.freeze({
  childProcessVar: 'require("node:child_process")',
  fsVar: 'require("node:fs")',
  pathVar: 'require("node:path")',
});

function agentWorkspaceAppPickerBridgeSource({ fsVar, pathVar }) {
  return [
    `"linux-agent-workspace-pick-app":async()=>{let __codexFsModule=${fsVar},__codexPathModule=${pathVar},__codexElectron;try{__codexElectron=require("electron")}catch(e){return{ok:!1,action:"pickStartupApp",message:"file picker unavailable"}}`,
    `let __codexDesktopTokens=e=>{let t=[],n="",r=null,a=!1,o=String(e||"");for(let i=0;i<o.length;i++){let c=o[i];if(a){n+=c,a=!1;continue}if(c==="\\\\"){a=!0;continue}if(r){if(c===r)r=null;else n+=c;continue}if(c==="'"||c==='"'){r=c;continue}if(/\\s/.test(c)){if(n)t.push(n),n="";continue}n+=c}if(a)n+="\\\\";if(n)t.push(n);return t};`,
    `let __codexDesktopEntry=__codexPath=>{if(typeof __codexPath!=="string"||!__codexPath.endsWith(".desktop"))return null;try{let __codexText=__codexFsModule.readFileSync(__codexPath,"utf8"),__codexInEntry=!1,__codexName=null,__codexExec=null;for(let __codexLine of __codexText.split(/\\r?\\n/)){let __codexTrimmed=__codexLine.trim();if(!__codexTrimmed||__codexTrimmed.startsWith("#"))continue;if(__codexTrimmed.startsWith("[")&&__codexTrimmed.endsWith("]")){__codexInEntry=__codexTrimmed==="[Desktop Entry]";continue}if(!__codexInEntry)continue;let __codexEquals=__codexTrimmed.indexOf("=");if(__codexEquals<1)continue;let __codexKey=__codexTrimmed.slice(0,__codexEquals),__codexValue=__codexTrimmed.slice(__codexEquals+1).trim();if((__codexKey==="Name"||__codexKey.startsWith("Name["))&&!__codexName)__codexName=__codexValue;else if(__codexKey==="Exec"&&!__codexExec)__codexExec=__codexValue}if(!__codexExec)return null;let __codexPercent="__CODEX_PERCENT__",__codexCleanExec=__codexExec.replace(/%%/g,__codexPercent).replace(/%[A-Za-z]/g,"").replace(new RegExp(__codexPercent,"g"),"%").trim(),__codexCommand=__codexDesktopTokens(__codexCleanExec);return __codexCommand.length?{name:__codexName||__codexPathModule.basename(__codexPath,".desktop"),command:__codexCommand,desktop_file:__codexPath}:null}catch{return null}};`,
    `try{let e=await __codexElectron.dialog.showOpenDialog({title:"Choose startup app",properties:["openFile"]});let t=Array.isArray(e.filePaths)?e.filePaths:[],n=t[0]||null,r=__codexDesktopEntry(n);return{ok:!e.canceled&&t.length>0,action:"pickStartupApp",json:{canceled:!!e.canceled,path:n,paths:t,startup_app:r,desktop:!!r}}}catch(e){return{ok:!1,action:"pickStartupApp",message:e instanceof Error?e.message:String(e)}}}`,
  ].join("");
}

// Binary resolution precedence (highest to lowest), all via execFile (never a shell):
//   1. Settings field (globalState SETTINGS_COMMAND_KEY) - explicit user override.
//   2. CODEX_AGENT_WORKSPACE_BIN env var.
//   3. Existing binary under CARGO_HOME/bin or ~/.cargo/bin.
//   4. npm global install under NPM_CONFIG_PREFIX, common home prefixes, or /usr/local.
//   5. PATH search for `agent-workspace-linux`.
//   6. ~/.local/bin/agent-workspace-linux - the local manual-install fallback.
//   7. Bare `agent-workspace-linux` - let the OS resolve and fail with a clear error.
const AGENT_WORKSPACE_BRIDGE_SOURCE_TEMPLATE = "\"linux-agent-workspace-pick-app\":async()=>{let __codexElectron;try{__codexElectron=require(\"electron\")}catch(e){return{ok:!1,action:\"pickStartupApp\",message:\"file picker unavailable\"}}let __codexDesktopTokens=e=>{let t=[],n=\"\",r=null,a=!1,o=String(e||\"\");for(let i=0;i<o.length;i++){let c=o[i];if(a){n+=c,a=!1;continue}if(c===\"\\\\\"){a=!0;continue}if(r){if(c===r)r=null;else n+=c;continue}if(c===\"'\"||c==='\"'){r=c;continue}if(/\\s/.test(c)){if(n)t.push(n),n=\"\";continue}n+=c}if(a)n+=\"\\\\\";if(n)t.push(n);return t};let __codexDesktopEntry=__codexPath=>{if(typeof __codexPath!==\"string\"||!__codexPath.endsWith(\".desktop\"))return null;try{let __codexText=__CODEX_FS_VAR__.readFileSync(__codexPath,\"utf8\"),__codexInEntry=!1,__codexName=null,__codexExec=null;for(let __codexLine of __codexText.split(/\\r?\\n/)){let __codexTrimmed=__codexLine.trim();if(!__codexTrimmed||__codexTrimmed.startsWith(\"#\"))continue;if(__codexTrimmed.startsWith(\"[\")&&__codexTrimmed.endsWith(\"]\")){__codexInEntry=__codexTrimmed===\"[Desktop Entry]\";continue}if(!__codexInEntry)continue;let __codexEquals=__codexTrimmed.indexOf(\"=\");if(__codexEquals<1)continue;let __codexKey=__codexTrimmed.slice(0,__codexEquals),__codexValue=__codexTrimmed.slice(__codexEquals+1).trim();if((__codexKey===\"Name\"||__codexKey.startsWith(\"Name[\"))&&!__codexName)__codexName=__codexValue;else if(__codexKey===\"Exec\"&&!__codexExec)__codexExec=__codexValue}if(!__codexExec)return null;let __codexPercent=\"__CODEX_PERCENT__\",__codexCleanExec=__codexExec.replace(/%%/g,__codexPercent).replace(/%[A-Za-z]/g,\"\").replace(new RegExp(__codexPercent,\"g\"),\"%\").trim(),__codexCommand=__codexDesktopTokens(__codexCleanExec);return __codexCommand.length?{name:__codexName||__CODEX_PATH_VAR__.basename(__codexPath,\".desktop\"),command:__codexCommand,desktop_file:__codexPath}:null}catch{return null}};try{let e=await __codexElectron.dialog.showOpenDialog({title:\"Choose startup app\",properties:[\"openFile\"]});let t=Array.isArray(e.filePaths)?e.filePaths:[],n=t[0]||null,r=__codexDesktopEntry(n);return{ok:!e.canceled&&t.length>0,action:\"pickStartupApp\",json:{canceled:!!e.canceled,path:n,paths:t,startup_app:r,desktop:!!r}}}catch(e){return{ok:!1,action:\"pickStartupApp\",message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace-pick-project\":async()=>{let __codexElectron;try{__codexElectron=require(`electron`)}catch(e){return{ok:!1,action:`pickProject`,message:`file picker unavailable`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:`Choose project folder`,properties:[`openDirectory`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:`pickProject`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:`pickProject`,message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace-pick-browser-data\":async()=>{let __codexElectron;try{__codexElectron=require(`electron`)}catch(e){return{ok:!1,action:`pickBrowserData`,message:`file picker unavailable`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:`Choose browser data folder`,properties:[`openDirectory`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:`pickBrowserData`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:`pickBrowserData`,message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace-copy-browser-data\":async({sourcePath:__codexSourcePath,profileId:__codexProfileId}={})=>{let __codexString=e=>typeof e===`string`&&e.trim().length>0?e.trim():null,__codexHome=()=>typeof process.env.HOME===`string`&&process.env.HOME.trim().length>0?process.env.HOME.trim():null,__codexExpand=e=>{let t=__codexString(e),n=__codexHome();return t&&t.startsWith(`~/`)&&n?__CODEX_PATH_VAR__.join(n,t.slice(2)):t},__codexSafe=e=>String(e||`browser-session`).toLowerCase().replace(/[^a-z0-9._-]+/g,`-`).replace(/^-+|-+$/g,``)||`browser-session`;try{let e=__codexExpand(__codexSourcePath);if(!e)return{ok:!1,action:`copyBrowserData`,message:`browser data folder is required`};if(!__CODEX_FS_VAR__.existsSync(e)||!__CODEX_FS_VAR__.statSync(e).isDirectory())return{ok:!1,action:`copyBrowserData`,message:`browser data folder does not exist`,json:{source_path:e}};let t=__codexSafe(__codexProfileId),n=__codexExpand(process.env.XDG_DATA_HOME)||(__codexHome()?__CODEX_PATH_VAR__.join(__codexHome(),`.local`,`share`):__CODEX_PATH_VAR__.join(process.env.TMPDIR||`/tmp`,`codex-agent-workspace-data`)),r=__CODEX_PATH_VAR__.join(n,`agent-workspace-linux`,`browser-sessions`,t);if(__CODEX_FS_VAR__.existsSync(r))return{ok:!1,action:`copyBrowserData`,message:`managed browser-session copy already exists`,json:{source_path:e,path:r,profile_id:t}};__CODEX_FS_VAR__.mkdirSync(__CODEX_PATH_VAR__.dirname(r),{recursive:!0,mode:448});let a=new Set([`SingletonCookie`,`SingletonLock`,`SingletonSocket`,`lockfile`,`.parentlock`]);await __CODEX_FS_VAR__.promises.cp(e,r,{recursive:!0,force:!1,errorOnExist:!0,filter:(e)=>{let t=__CODEX_PATH_VAR__.basename(e);return !a.has(t)&&!t.startsWith(`Singleton`)}});return{ok:!0,action:`copyBrowserData`,json:{source_path:e,path:r,profile_id:t,copied:!0,excluded_lock_files:!0}}}catch(e){return{ok:!1,action:`copyBrowserData`,message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace\":async({action:__codexAction,timeoutMs:__codexTimeoutMs,profileId:__codexProfileId,profile:__codexProfile,replace:__codexReplace,dryRun:__codexDryRun,workspaceId:__codexWorkspaceId,purpose:__codexPurpose,runSetup:__codexRunSetup,ackHiddenWorkspace:__codexAckHiddenWorkspace,startupWaitWindow:__codexStartupWaitWindow,startupScreenshotWindow:__codexStartupScreenshotWindow,cleanupId:__codexCleanupId,outputPath:__codexOutputPath,templateKind:__codexTemplateKind,hostPath:__codexHostPath,browserPath:__codexBrowserPath,userDataDir:__codexUserDataDir,alwaysOnTop:__codexAlwaysOnTop,permissions:__codexPermissions}={})=>{let __codexHome=()=>typeof process.env.HOME===`string`&&process.env.HOME.trim().length>0?process.env.HOME.trim():null,__codexExpandCommand=e=>{if(typeof e!==`string`)return e;let t=e.trim(),n=__codexHome();return t.startsWith(`~/`)&&n?__CODEX_PATH_VAR__.join(n,t.slice(2)):t},__codexBinExists=p=>{try{return typeof p===`string`&&p.length>0&&__CODEX_FS_VAR__.existsSync(p)&&__CODEX_FS_VAR__.statSync(p).isFile()}catch{return!1}},__codexAddCandidate=(e,t)=>{t&&e.indexOf(t)===-1&&e.push(t)},__codexFromPathCandidates=e=>{let t=[];if(typeof process.env.PATH!==`string`||process.env.PATH.length===0)return t;for(let n of process.env.PATH.split(__CODEX_PATH_VAR__.delimiter)){if(!n)continue;__codexAddCandidate(t,__CODEX_PATH_VAR__.join(n,e))}return t},__codexFirstExisting=e=>{for(let t of e){if(__codexBinExists(t))return t}return null},__codexDefaultCandidates=()=>{let e=[],t=__codexHome(),n=(typeof process.env.CARGO_HOME===`string`&&process.env.CARGO_HOME.trim().length>0?process.env.CARGO_HOME.trim():null);n=__codexExpandCommand(n||(t?__CODEX_PATH_VAR__.join(t,`.cargo`):null)),__codexAddCandidate(e,n?__CODEX_PATH_VAR__.join(n,`bin`,`agent-workspace-linux`):null);let r=(typeof process.env.NPM_CONFIG_PREFIX===`string`&&process.env.NPM_CONFIG_PREFIX.trim().length>0?process.env.NPM_CONFIG_PREFIX.trim():null);r&&__codexAddCandidate(e,__CODEX_PATH_VAR__.join(__codexExpandCommand(r),`bin`,`agent-workspace-linux`));if(t){__codexAddCandidate(e,__CODEX_PATH_VAR__.join(t,`.npm-global`,`bin`,`agent-workspace-linux`));__codexAddCandidate(e,__CODEX_PATH_VAR__.join(t,`.local`,`share`,`npm`,`bin`,`agent-workspace-linux`))}__codexAddCandidate(e,`/usr/local/bin/agent-workspace-linux`);__codexAddCandidate(e,`/usr/local/lib/node_modules/@agent-sh/agent-workspace-linux/bin/agent-workspace-linux.js`);__codexAddCandidate(e,`/usr/local/lib/node_modules/@agent-sh/agent-workspace-linux/bin/agent-workspace-linux`);for(let t of __codexFromPathCandidates(`agent-workspace-linux`))__codexAddCandidate(e,t);t&&__codexAddCandidate(e,__CODEX_PATH_VAR__.join(t,`.local`,`bin`,`agent-workspace-linux`));return e},__codexFromPath=()=>__codexFirstExisting(__codexFromPathCandidates(`agent-workspace-linux`)),__codexDefaultCommand=()=>{let e=process.env.CODEX_AGENT_WORKSPACE_BIN;if(typeof e===`string`&&e.trim().length>0)return __codexExpandCommand(e);return __codexFirstExisting(__codexDefaultCandidates())||`agent-workspace-linux`},__codexCommand=this.globalState.get(`codex-linux-agent-workspace-command`)||__codexDefaultCommand();if(typeof __codexCommand!==`string`||__codexCommand.trim().length===0)__codexCommand=__codexDefaultCommand();__codexCommand=__codexExpandCommand(__codexCommand);let __codexArgs=[],__codexTempPath=null,__codexString=e=>typeof e===`string`&&e.trim().length>0?e.trim():null,__codexDataHome=()=>{let e=__codexString(process.env.XDG_DATA_HOME);return e?__codexExpandCommand(e):(__codexHome()?__CODEX_PATH_VAR__.join(__codexHome(),`.local`,`share`):__CODEX_PATH_VAR__.join(process.env.TMPDIR||`/tmp`,`codex-agent-workspace-data`))},__codexPermissionPath=__codexString(this.globalState.get(`codex-linux-agent-workspace-permissions`));__codexPermissionPath&&(__codexPermissionPath=__codexExpandCommand(__codexPermissionPath));let __codexReadPermissionConfig=e=>{if(!e)return{configured:!1,restricted:!1,permissions_path:null,message:`No workspace permission file configured`};let t=null,n=null;try{__CODEX_FS_VAR__.existsSync(e)?t=JSON.parse(__CODEX_FS_VAR__.readFileSync(e,`utf8`)):n=`permission file does not exist`}catch(e){n=e instanceof Error?e.message:String(e)}let r=!!(t&&Array.isArray(t.apps?.allow)&&t.apps.allow.length>0);return{configured:!0,restricted:n?!0:r,permissions_path:e,ceiling:t,error:n,message:n?`Permission file could not be loaded`:r?`Permission file is active`:`Permission file is configured but open; Codex session permissions apply`}},__codexPermissionConfig=__codexReadPermissionConfig(__codexPermissionPath),__codexPushId=(e,t)=>{let n=__codexString(t);if(n)__codexArgs.push(e,n)},__codexActionName=__codexString(__codexAction);try{switch(__codexActionName){case`installRuntime`:{let e=`npm`,t=__codexFirstExisting(__codexFromPathCandidates(e))||e,n=[`install`,`-g`,`@agent-sh/agent-workspace-linux`],r=Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):3e5;return await new Promise(o=>{__CODEX_CHILD_PROCESS_VAR__.execFile(t,n,{encoding:`utf8`,timeout:r,maxBuffer:16777216},(r,a,i)=>{r?o({ok:!1,action:__codexActionName,manager:e,command:t,args:n,message:r instanceof Error?r.message:String(r),code:r?.code??null,stdout:a||``,stderr:i||``}):o({ok:!0,action:__codexActionName,manager:e,command:t,args:n,stdout:a||``,stderr:i||``,json:{ok:!0,manager:e}})})})}case`version`:return await new Promise(o=>{__CODEX_CHILD_PROCESS_VAR__.execFile(__codexCommand,[`--version`],{encoding:`utf8`,timeout:Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):15e3,maxBuffer:65536},(r,a,i)=>{let n=String(a||``).trim().match(/^agent-workspace-linux (\\d+\\.\\d+\\.\\d+)/);o({ok:!r&&!!n,action:__codexActionName,command:__codexCommand,args:[`--version`],stdout:a||``,stderr:i||``,message:r?(r instanceof Error?r.message:String(r)):n?void 0:`unrecognized version output`,json:{version:n?n[1]:null}})})});case`permissionConfig`:return{ok:!__codexPermissionConfig.error,action:__codexActionName,json:__codexPermissionConfig,message:__codexPermissionConfig.error||void 0};case`permissionSave`:{let e=__codexPermissions;if(!e||typeof e!==`object`||Array.isArray(e))return{ok:!1,action:__codexActionName,message:`permissions object is required`};let n=e.apps;if(n!=null&&(typeof n!==`object`||Array.isArray(n)))return{ok:!1,action:__codexActionName,message:`permission apps must be an object`};if(n?.allow!=null&&!Array.isArray(n.allow))return{ok:!1,action:__codexActionName,message:`permission app allow must be a list`};let t={apps:{allow:Array.isArray(n?.allow)?[...n.allow]:[]}};for(let e of t.apps.allow){if(typeof e!==`string`||!e.trim())return{ok:!1,action:__codexActionName,message:`permission app allow entries must be non-empty strings`};if(!e.startsWith(`/`)&&e.includes(`/`))return{ok:!1,action:__codexActionName,message:`permission app allow entries must be absolute paths or bare command names`}}let r=__CODEX_PATH_VAR__.join(__codexDataHome(),`agent-workspace-linux`,`permissions`),a=__CODEX_PATH_VAR__.join(r,`codex-agent-workspace-permissions.json`);try{__CODEX_FS_VAR__.mkdirSync(r,{recursive:!0,mode:448}),__CODEX_FS_VAR__.writeFileSync(a,JSON.stringify(t,null,2)+`\\n`,{encoding:`utf8`,mode:384}),this.globalState.set(`codex-linux-agent-workspace-permissions`,a)}catch(e){return{ok:!1,action:__codexActionName,message:e instanceof Error?e.message:String(e)}}__codexPermissionConfig=__codexReadPermissionConfig(a);return{ok:!__codexPermissionConfig.error,action:__codexActionName,json:__codexPermissionConfig,message:__codexPermissionConfig.error||void 0}}case`doctor`:__codexArgs=[`doctor`];break;case`guardrails`:__codexArgs=[`guardrails`];break;case`profilePath`:__codexArgs=[`profile`,`path`];break;case`profileList`:__codexArgs=[`profile`,`list`];break;case`profileGet`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`get`,e];break}case`profileCheck`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`check`,e];break}case`profileDelete`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`delete`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexArgs.push(e);break}case`profileExport`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`export`,e],__codexPushId(`--output`,__codexOutputPath),__codexReplace&&__codexArgs.push(`--replace`);break}case`profileTemplate`:{let e=__codexString(__codexTemplateKind)||`project-dev`;__codexArgs=[`profile`,`template`,e],__codexPushId(`--id`,__codexProfileId),__codexPushId(`--host-path`,__codexHostPath),__codexPushId(`--browser-path`,__codexBrowserPath),__codexPushId(`--user-data-dir`,__codexUserDataDir);break}case`profileValidate`:{if(!__codexProfile||typeof __codexProfile!==`object`||Array.isArray(__codexProfile))throw Error(`profile object is required`);let e=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||`/tmp`,t=__CODEX_FS_VAR__.mkdtempSync(__CODEX_PATH_VAR__.join(e,`codex-agent-workspace-`));__codexTempPath=__CODEX_PATH_VAR__.join(t,`profile.json`),__CODEX_FS_VAR__.writeFileSync(__codexTempPath,JSON.stringify(__codexProfile,null,2)+`\\n`,{encoding:`utf8`,mode:384}),__codexArgs=[`profile`,`validate`,`--json`,__codexTempPath];break}case`profileSave`:{if(!__codexProfile||typeof __codexProfile!==`object`||Array.isArray(__codexProfile))throw Error(`profile object is required`);let e=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||`/tmp`,t=__CODEX_FS_VAR__.mkdtempSync(__CODEX_PATH_VAR__.join(e,`codex-agent-workspace-`));__codexTempPath=__CODEX_PATH_VAR__.join(t,`profile.json`),__CODEX_FS_VAR__.writeFileSync(__codexTempPath,JSON.stringify(__codexProfile,null,2)+`\\n`,{encoding:`utf8`,mode:384}),__codexArgs=[`profile`,`put`,`--json`,__codexTempPath],__codexReplace&&__codexArgs.push(`--replace`),__codexDryRun&&__codexArgs.push(`--dry-run`);break}case`workspaceList`:__codexArgs=[`workspace`,`list`];break;case`workspaceStatus`:__codexArgs=[`workspace`,`status`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceManifest`:__codexArgs=[`workspace`,`manifest`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceArtifacts`:__codexArgs=[`workspace`,`artifacts`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceOpenProfile`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`workspace`,`open-profile`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexAckHiddenWorkspace&&__codexArgs.push(`--ack-hidden-workspace`),__codexArgs.push(`--profile`,e),__codexPushId(`--id`,__codexWorkspaceId),__codexPushId(`--purpose`,__codexPurpose),__codexRunSetup&&__codexArgs.push(`--setup`),__codexStartupWaitWindow&&__codexArgs.push(`--startup-wait-window`),__codexStartupScreenshotWindow&&__codexArgs.push(`--startup-screenshot-window`);break}case`workspaceOpenViewer`:{let e=__codexString(__codexWorkspaceId);__codexArgs=[`viewer`],e&&__codexArgs.push(`--id`,e,`--exit-when-workspace-gone`),__codexAlwaysOnTop&&__codexArgs.push(`--always-on-top`);break}case`workspaceStart`:{__codexArgs=[`workspace`,`start`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexAckHiddenWorkspace&&__codexArgs.push(`--ack-hidden-workspace`),__codexPushId(`--profile`,__codexProfileId),__codexPushId(`--id`,__codexWorkspaceId),__codexPushId(`--purpose`,__codexPurpose);break}case`workspaceStop`:__codexArgs=[`workspace`,`stop`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceCleanup`:__codexArgs=[`workspace`,`cleanup`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexPushId(`--id`,__codexCleanupId);break;default:throw Error(`unsupported agent workspace action`)}}catch(e){return{ok:!1,action:__codexActionName,message:e instanceof Error?e.message:String(e)}}if(__codexPermissionConfig?.error)return{ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:`Workspace permission file could not be loaded: ${__codexPermissionConfig.error}`,json:__codexPermissionConfig};if(__codexPermissionConfig?.permissions_path)__codexArgs=[`--permissions`,__codexPermissionConfig.permissions_path,...__codexArgs];if(__codexActionName===`workspaceOpenViewer`){return await new Promise(e=>{let t=!1,n=null,r=a=>{if(t)return;t=!0,n&&clearTimeout(n),e(a)},m=a=>a instanceof Error?a.message:String(a);try{let a=__CODEX_CHILD_PROCESS_VAR__.spawn(__codexCommand,__codexArgs,{detached:!0,stdio:`ignore`}),p={ok:!0,action:__codexActionName,command:__codexCommand,args:__codexArgs,json:{ok:!0,id:__codexString(__codexWorkspaceId)||`default`,pid:a?.pid??null,always_on_top:!!__codexAlwaysOnTop,exit_when_workspace_gone:!!__codexString(__codexWorkspaceId)}};a?.once?.(`error`,e=>r({ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:m(e)}));a?.once?.(`spawn`,()=>{a?.unref?.();r(p)});n=setTimeout(()=>{a?.unref?.();r(p)},25)}catch(a){r({ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:m(a)})}})}let __codexParse=e=>{let t=String(e||``).trim();if(t.length===0)return null;try{return JSON.parse(t)}catch{return{raw:t}}};try{let e=await new Promise((e,t)=>{let n=__CODEX_CHILD_PROCESS_VAR__.execFile(__codexCommand,__codexArgs,{encoding:`utf8`,timeout:Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):15e3,maxBuffer:8388608},(n,r,i)=>{n?(n.stdout=r,n.stderr=i,t(n)):e({stdout:r,stderr:i})})}),t=__codexParse(e.stdout);return{ok:!0,action:__codexActionName,command:__codexCommand,args:__codexArgs,stdout:e.stdout,stderr:e.stderr,json:t}}catch(e){let t=__codexParse(e?.stdout);return{ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:e instanceof Error?e.message:String(e),code:e?.code??null,stdout:e?.stdout??``,stderr:e?.stderr??``,json:t}}finally{if(__codexTempPath)try{__CODEX_FS_VAR__.rmSync(__CODEX_PATH_VAR__.dirname(__codexTempPath),{recursive:!0,force:!0})}catch{}}}";

function agentWorkspaceProjectPickerBridgeSource() {
  return `"linux-agent-workspace-pick-project":async()=>{let __codexElectron;try{__codexElectron=require(\`electron\`)}catch(e){return{ok:!1,action:\`pickProject\`,message:\`file picker unavailable\`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:\`Choose project folder\`,properties:[\`openDirectory\`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:\`pickProject\`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:\`pickProject\`,message:e instanceof Error?e.message:String(e)}}}`;
}

function agentWorkspaceBrowserDataPickerBridgeSource() {
  return `"linux-agent-workspace-pick-browser-data":async()=>{let __codexElectron;try{__codexElectron=require(\`electron\`)}catch(e){return{ok:!1,action:\`pickBrowserData\`,message:\`file picker unavailable\`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:\`Choose browser data folder\`,properties:[\`openDirectory\`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:\`pickBrowserData\`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:\`pickBrowserData\`,message:e instanceof Error?e.message:String(e)}}}`;
}

function agentWorkspaceBrowserDataCopyBridgeSource({ fsVar, pathVar }) {
  return `"linux-agent-workspace-copy-browser-data":async({sourcePath:__codexSourcePath,profileId:__codexProfileId}={})=>{let __codexString=e=>typeof e===\`string\`&&e.trim().length>0?e.trim():null,__codexHome=()=>typeof process.env.HOME===\`string\`&&process.env.HOME.trim().length>0?process.env.HOME.trim():null,__codexExpand=e=>{let t=__codexString(e),n=__codexHome();return t&&t.startsWith(\`~/\`)&&n?${pathVar}.join(n,t.slice(2)):t},__codexSafe=e=>String(e||\`browser-session\`).toLowerCase().replace(/[^a-z0-9._-]+/g,\`-\`).replace(/^-+|-+$/g,\`\`)||\`browser-session\`;try{let e=__codexExpand(__codexSourcePath);if(!e)return{ok:!1,action:\`copyBrowserData\`,message:\`browser data folder is required\`};if(!${fsVar}.existsSync(e)||!${fsVar}.statSync(e).isDirectory())return{ok:!1,action:\`copyBrowserData\`,message:\`browser data folder does not exist\`,json:{source_path:e}};let t=__codexSafe(__codexProfileId),n=__codexExpand(process.env.XDG_DATA_HOME)||(__codexHome()?${pathVar}.join(__codexHome(),\`.local\`,\`share\`):${pathVar}.join(process.env.TMPDIR||\`/tmp\`,\`codex-agent-workspace-data\`)),r=${pathVar}.join(n,\`agent-workspace-linux\`,\`browser-sessions\`,t);if(${fsVar}.existsSync(r))return{ok:!1,action:\`copyBrowserData\`,message:\`managed browser-session copy already exists\`,json:{source_path:e,path:r,profile_id:t}};${fsVar}.mkdirSync(${pathVar}.dirname(r),{recursive:!0,mode:448});let a=new Set([\`SingletonCookie\`,\`SingletonLock\`,\`SingletonSocket\`,\`lockfile\`,\`.parentlock\`]);await ${fsVar}.promises.cp(e,r,{recursive:!0,force:!1,errorOnExist:!0,filter:(e)=>{let t=${pathVar}.basename(e);return !a.has(t)&&!t.startsWith(\`Singleton\`)}});return{ok:!0,action:\`copyBrowserData\`,json:{source_path:e,path:r,profile_id:t,copied:!0,excluded_lock_files:!0}}}catch(e){return{ok:!1,action:\`copyBrowserData\`,message:e instanceof Error?e.message:String(e)}}}`;
}

// npm resolves the range itself; execFile passes it as one argv entry, so no shell quoting.
const NPM_PACKAGE_SPEC = "@agent-sh/agent-workspace-linux@>=0.6.0";

function useUserWritableNpmPrefixForInstallRuntime(source) {
  return replaceBridgeCase(source, "installRuntime", "version", `case\`installRuntime\`:{
    const manager="npm",npm=__codexFirstExisting(__codexFromPathCandidates(manager))||manager;
    const timeout=Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):300000;
    const run=args=>new Promise(resolve=>{
      __CODEX_CHILD_PROCESS_VAR__.execFile(npm,args,{encoding:"utf8",timeout,maxBuffer:16777216},(error,stdout,stderr)=>{
        resolve({ok:!error,action:__codexActionName,manager,command:npm,args,stdout:stdout||"",stderr:stderr||"",message:error?(error instanceof Error?error.message:String(error)):void 0,code:error?.code??null});
      });
    });
    let prefix=__codexString(process.env.NPM_CONFIG_PREFIX);
    prefix=prefix?__codexExpandCommand(prefix):(__codexHome()?__CODEX_PATH_VAR__.join(__codexHome(),".local"):null);
    if(!prefix){
      const resolved=await run(["prefix","-g"]);
      if(!resolved.ok)return resolved;
      prefix=resolved.stdout.trim();
      if(!__CODEX_PATH_VAR__.isAbsolute(prefix))return {...resolved,ok:!1,message:"npm did not report an absolute installation prefix"};
    }
    prefix=__CODEX_PATH_VAR__.resolve(prefix);
    const result=await run(["install","-g","--prefix",prefix,${JSON.stringify(NPM_PACKAGE_SPEC)}]);
    if(result.ok)result.json={ok:!0,manager,command:__CODEX_PATH_VAR__.join(prefix,"bin","agent-workspace-linux")};
    return result;
  }`);
}

function replaceBridgeCase(source, action, nextAction, replacement) {
  const start = source.indexOf(`case\`${action}\`:`);
  const end = source.indexOf(`case\`${nextAction}\`:`, start);
  if (start < 0 || end < 0) throw new Error(`could not update agent workspace ${action} command`);
  return source.slice(0, start) + replacement + source.slice(end);
}

function agentWorkspaceVersionBridgeSource(source) {
  return replaceBridgeCase(source, "version", "permissionConfig", `case\`version\`:return await new Promise(resolve=>{
    __CODEX_CHILD_PROCESS_VAR__.execFile(__codexCommand,["--version"],{encoding:"utf8",timeout:Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):15000,maxBuffer:65536},(error,stdout,stderr)=>{
      const match=String(stdout||"").trim().match(/^agent-workspace-linux (\\d+\\.\\d+\\.\\d+)/);
      resolve({ok:!error&&!!match,action:__codexActionName,command:__codexCommand,args:["--version"],stdout:stdout||"",stderr:stderr||"",message:error?(error instanceof Error?error.message:String(error)):match?void 0:"unrecognized version output",code:error?.code??null,timedOut:!!error?.killed||error?.code==="ETIMEDOUT",json:{version:match?match[1]:null}});
    });
  });`);
}

function agentWorkspaceBridgeWithWorkspaceStartSource(args) {
  let source = agentWorkspaceVersionBridgeSource(useUserWritableNpmPrefixForInstallRuntime(AGENT_WORKSPACE_BRIDGE_SOURCE_TEMPLATE))
    .split("__CODEX_CHILD_PROCESS_VAR__").join("__codexChildProcessModule")
    .split("__CODEX_FS_VAR__").join("__codexFsModule")
    .split("__CODEX_PATH_VAR__").join("__codexPathModule");
  const captures = [
    [
      `"linux-agent-workspace-pick-app":async()=>{`,
      `let __codexFsModule=${args.fsVar},__codexPathModule=${args.pathVar};`,
    ],
    [
      `"linux-agent-workspace-copy-browser-data":async({sourcePath:__codexSourcePath,profileId:__codexProfileId}={})=>{`,
      `let __codexFsModule=${args.fsVar},__codexPathModule=${args.pathVar};`,
    ],
    [
      `"linux-agent-workspace":async({action:__codexAction,timeoutMs:__codexTimeoutMs,profileId:__codexProfileId,profile:__codexProfile,replace:__codexReplace,dryRun:__codexDryRun,workspaceId:__codexWorkspaceId,purpose:__codexPurpose,runSetup:__codexRunSetup,ackHiddenWorkspace:__codexAckHiddenWorkspace,startupWaitWindow:__codexStartupWaitWindow,startupScreenshotWindow:__codexStartupScreenshotWindow,cleanupId:__codexCleanupId,outputPath:__codexOutputPath,templateKind:__codexTemplateKind,hostPath:__codexHostPath,browserPath:__codexBrowserPath,userDataDir:__codexUserDataDir,alwaysOnTop:__codexAlwaysOnTop,permissions:__codexPermissions}={})=>{`,
      `let __codexChildProcessModule=${args.childProcessVar},__codexFsModule=${args.fsVar},__codexPathModule=${args.pathVar};`,
    ],
  ];
  for (const [marker, capture] of captures) {
    if (!source.includes(marker)) {
      throw new Error(`could not add agent workspace module capture for ${marker}`);
    }
    source = source.replace(marker, `${marker}${capture}`);
  }
  return source;
}

function agentWorkspaceActionBridgeSource(args) {
  const fullSource = agentWorkspaceBridgeWithWorkspaceStartSource(args);
  const marker = `"linux-agent-workspace":async`;
  const index = fullSource.indexOf(marker);
  if (index === -1) {
    throw new Error("could not find generated agent workspace action bridge");
  }
  return fullSource.slice(index);
}

function agentWorkspaceHandlersSource() {
  const args = NODE_MODULE_EXPRESSIONS;
  const entries = [
    globalStateHandlers().slice(0, -1),
    agentWorkspaceAppPickerBridgeSource(args),
    agentWorkspaceProjectPickerBridgeSource(),
    agentWorkspaceBrowserDataPickerBridgeSource(),
    agentWorkspaceBrowserDataCopyBridgeSource(args),
    agentWorkspaceActionBridgeSource(args),
  ];
  return `${HANDLERS_HELPER}){return{${entries.join(",")}}}`;
}

// Called with the main-process message handler as `this`, so the handlers'
// arrow functions read and write that handler's global state.
function agentWorkspaceFetchSource() {
  return `${FETCH_HELPER}codexLinuxRequest,codexLinuxReply){` +
    'let codexLinuxUrl=codexLinuxRequest?.url;if("string"!=typeof codexLinuxUrl||!codexLinuxUrl.startsWith("vscode://codex/"))return!1;' +
    'let codexLinuxHandlers=codexLinuxAgentWorkspaceHandlers.call(this),codexLinuxMethod=codexLinuxUrl.slice(15);' +
    "if(!Object.prototype.hasOwnProperty.call(codexLinuxHandlers,codexLinuxMethod))return!1;" +
    'try{let codexLinuxBody=codexLinuxRequest.body,codexLinuxParams="string"==typeof codexLinuxBody&&codexLinuxBody.length>0?JSON.parse(codexLinuxBody):{};' +
    "let codexLinuxResult=await codexLinuxHandlers[codexLinuxMethod](codexLinuxParams??{});" +
    'codexLinuxReply({type:"fetch-response",responseType:"success",requestId:codexLinuxRequest.requestId,status:200,headers:{"content-type":"application/json"},bodyJsonString:JSON.stringify(codexLinuxResult??null)})}' +
    'catch(e){codexLinuxReply({type:"fetch-response",responseType:"error",requestId:codexLinuxRequest.requestId,status:500,error:e instanceof Error?e.message:String(e)})}' +
    "return!0}";
}

const VIEW_HANDLER_FIELDS = ["fetchWrapper;", "globalState;", "chunkedMessageSender;"];
const CLASS_OPEN = /class [A-Za-z_$][\w$]*(?: extends [A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\{/g;

// Other Linux features route their own URLs in the same `case"fetch"`; they
// are tolerated in front of this route only as complete codex-linux routes.
function findFetchClause(source) {
  const clauses = [...source.matchAll(FETCH_CLAUSE)];
  if (clauses.length !== 1) return null;
  const [clause] = clauses;
  const [, webContents, message] = clause;
  const caseIndex = source.lastIndexOf('case"fetch":', clause.index);
  if (caseIndex < 0) return null;
  const between = source.slice(caseIndex + 'case"fetch":'.length, clause.index);
  if (between.length > 0 && !between.startsWith("/*codex-linux-")) return null;
  // The clause belongs to the view-message handler class that owns the global
  // state and the inline view-message sender used by the dictation route.
  // Look the class up by its field declarations, not the nearest "class "
  // keyword: other Linux features inject helpers (some declaring their own
  // classes) into the handler's methods.
  const owners = [...source.slice(0, caseIndex).matchAll(CLASS_OPEN)]
    .map((match) => match.index + match[0].length - 1)
    .filter((open) => {
      const fields = source.slice(open, open + 1000).split(/[(=]/, 1)[0];
      return VIEW_HANDLER_FIELDS.every((field) => fields.includes(field));
    });
  if (owners.length !== 1) return null;
  const [classOpen] = owners;
  if (findMatchingBrace(source, classOpen) < clause.index) return null;
  if (source.lastIndexOf(`async handleMessage(${webContents},${message}){`, caseIndex) < classOpen) return null;
  return { index: caseIndex + 'case"fetch":'.length, webContents, message };
}

function applyAgentWorkspaceMainBridgePatch(currentSource) {
  const patchName = "agent workspace main bridge patch";
  const routeCount = countOccurrences(currentSource, FETCH_ROUTE_MARKER);
  const handlersCount = countOccurrences(currentSource, HANDLERS_HELPER);
  const fetchCount = countOccurrences(currentSource, FETCH_HELPER);
  if (routeCount > 0 || handlersCount > 0 || fetchCount > 0) {
    if (routeCount !== 1 || handlersCount !== 1 || fetchCount !== 1 ||
        !currentSource.includes(agentWorkspaceHandlersSource()) || !currentSource.includes(agentWorkspaceFetchSource())) {
      warn("Found incomplete or stale agent workspace main bridge", patchName);
    }
    return currentSource;
  }
  const clause = findFetchClause(currentSource);
  if (clause == null) {
    warn("Could not find the main-process fetch message route", patchName);
    return currentSource;
  }
  const route = `${FETCH_ROUTE_MARKER}if(await codexLinuxAgentWorkspaceFetch.call(this,${clause.message},` +
    `codexLinuxMessage=>this.chunkedMessageSender.sendInlineMessageForView(${clause.webContents},codexLinuxMessage)))break;`;
  const patched = `${currentSource.slice(0, clause.index)}${route}${currentSource.slice(clause.index)}`;
  // Declare the helpers at chunk scope, before a trailing source-map comment.
  const sourceMap = patched.match(/\n\/\/# sourceMappingURL=[^\n]*\n?$/);
  const insertAt = sourceMap == null ? patched.length : sourceMap.index;
  return `${patched.slice(0, insertAt)}\n${agentWorkspaceHandlersSource()}${agentWorkspaceFetchSource()}${patched.slice(insertAt)}`;
}

// The settings page is an extra ESM asset beside the rspack chunks. Chunks no
// longer export modules to plain ESM files, so the settings route passes the
// webview's React and Codex request function in through this factory.
function buildAgentWorkspaceSettingsSource() {
  return `var React,h,__post;
function createAgentWorkspacesSettings(dependencies){
  React=dependencies.React;
  h=React.createElement;
  __post=dependencies.post;
  return AgentWorkspacesSettings;
}
function SettingsPage({title,subtitle,children}){
  return h("div",{className:"h-full min-h-0 w-full overflow-y-auto"},
    h("div",{className:"mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6"},
      h("div",{className:"flex flex-col gap-1"},
        h("h2",{className:"text-xl font-semibold text-token-text-primary"},title),
        subtitle?h("p",{className:"text-sm text-token-text-secondary"},subtitle):null
      ),
      children
    )
  );
}
var COMMAND_KEY=${JSON.stringify(SETTINGS_COMMAND_KEY)};
var PERMISSIONS_KEY=${JSON.stringify(SETTINGS_PERMISSIONS_KEY)};
var DEFAULT_COMMAND_LABEL="Auto-discovered agent-workspace-linux";
var MINIMUM_VERSION="0.6.0";
var RUNS_AS_YOU_TEXT="Apps in a workspace run as you, with your files, network, keyring and SSH agent. Only their windows stay in the workspace.";

function versionAtLeast(version,minimum){
  var have=String(version).split(".").map(Number);
  var need=minimum.split(".").map(Number);
  for(var index=0;index<need.length;index++){
    if(have[index]!==need[index])return have[index]>need[index];
  }
  return true;
}

function versionGateFromResponse(response){
  var installed=typeof response?.json?.version==="string"?response.json.version:null;
  var command=typeof response?.command==="string"?response.command:null;
  var detail=response?.message||String(response?.stderr||"").trim()||"unrecognized version output";
  if(response?.ok!==false&&installed)return {status:versionAtLeast(installed,MINIMUM_VERSION)?"ok":"too_old",installed:installed,command:command};
  if(response?.code==="ENOENT")return {status:"not_found",command:command};
  if(response?.timedOut)return {status:"timed_out",command:command};
  if(/(?:unknown|unrecognized|unexpected|unsupported)\\s+(?:command|argument|option|flag)[^\\n]*--version/i.test(String(response?.stderr||"")+" "+detail))return {status:"too_old",installed:null,command:command};
  return {status:"check_failed",command:command,detail:detail};
}

function versionGateMessage(gate){
  var target="agent-workspace-linux"+(gate.command?" at "+gate.command:"");
  if(gate.status==="not_found")return target+" was not found. Install from npm or choose its executable in Command.";
  if(gate.status==="timed_out")return "Checking "+target+" timed out. Check Command and try Reconnect.";
  if(gate.status==="check_failed")return "Could not check "+target+": "+gate.detail;
  return "This page needs agent-workspace-linux "+MINIMUM_VERSION+" or newer; installed: "+(gate.installed||"too old to report a version")+". Update with Install from npm.";
}

function pretty(value){
  return JSON.stringify(value,null,2);
}

function parseProfile(value){
  try{
    var parsed=JSON.parse(value);
    return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:null;
  }catch{
    return null;
  }
}

function responseOk(response){
  return response?.ok!==false&&response?.json?.ok!==false;
}

function profileFromResponse(response){
  var candidate=response?.json?.profile??response?.json;
  return responseOk(response)&&candidate&&typeof candidate==="object"&&!Array.isArray(candidate)&&typeof candidate.id==="string"?candidate:null;
}

function defaultProfile(){
  return {
    id:"desktop-qa",
    description:"Desktop QA environment",
    width:1280,
    height:800,
    setup_commands:[],
    startup_apps:[]
  };
}

function defaultPermissions(){
  return {
    apps:{allow:[]}
  };
}

function normalizePermissions(value){
  var source=value&&typeof value==="object"&&!Array.isArray(value)?value:{};
  return {
    apps:{allow:(Array.isArray(source.apps?.allow)?source.apps.allow:[]).map(String).filter(Boolean)}
  };
}

function permissionsFromConfig(config){
  return normalizePermissions(config?.ceiling||defaultPermissions());
}

function button(label,disabled,onClick){
  return h("button",{
    type:"button",
    className:"rounded-md border border-token-border-default px-3 py-1.5 text-sm text-token-text-primary hover:bg-token-main-surface-secondary disabled:cursor-not-allowed disabled:opacity-50",
    disabled:!!disabled,
    onClick
  },label);
}

function toggleButton(label,selected,disabled,onClick){
  var selectedClass=selected
    ? "border-token-border-strong bg-token-main-surface-secondary text-token-text-primary"
    : "border-token-border-default text-token-text-primary";
  return h("button",{
    type:"button",
    className:"rounded-md border px-3 py-1.5 text-sm hover:bg-token-main-surface-secondary disabled:cursor-not-allowed disabled:opacity-50 "+selectedClass,
    disabled:!!disabled,
    "aria-pressed":!!selected,
    onClick
  },label);
}

function field(label,value,onChange,placeholder,disabled){
  return h("label",{className:"flex flex-col gap-1 text-sm text-token-text-secondary"},
    h("span",null,label),
    h("input",{
      className:"h-9 rounded-md border border-token-border-default bg-token-bg-primary px-2 text-token-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-60",
      value,
      onChange:function(event){onChange(event.target.value);},
      placeholder:placeholder||"",
      disabled:!!disabled
    })
  );
}

function commandText(command){
  return Array.isArray(command)?command.join(" "):"";
}

function baseName(filePath){
  var value=String(filePath||"").split("/").filter(Boolean).pop()||"app";
  return value.endsWith(".desktop")?value.slice(0,-8):value;
}

function startupAppFromPath(filePath){
  var name=baseName(filePath);
  if(String(filePath||"").endsWith(".desktop"))return {name:name,command:["gtk-launch",name]};
  return {name:name,command:[filePath]};
}

function commandArgv(command){
  var args=[];
  var current="";
  var quote=null;
  var escaped=false;
  var hadToken=false;
  var text=String(command||"").trim();
  for(var index=0;index<text.length;index++){
    var char=text[index];
    if(escaped){current+=char;escaped=false;hadToken=true;continue;}
    if(char==="\\\\"){escaped=true;hadToken=true;continue;}
    if(quote){
      if(char===quote)quote=null;
      else current+=char;
      hadToken=true;
      continue;
    }
    if(char==="'"||char==='\"'){quote=char;hadToken=true;continue;}
    if(/\\s/.test(char)){
      if(hadToken){args.push(current);current="";hadToken=false;}
      continue;
    }
    current+=char;
    hadToken=true;
  }
  if(escaped)current+="\\\\";
  if(quote)throw new Error("Manual app command has an unterminated quote");
  if(hadToken)args.push(current);
  return args;
}

function startupAppFromManual(command){
  var argv=commandArgv(command);
  if(argv.length===0)throw new Error("Manual app command is required");
  if(!argv[0])throw new Error("Manual app command program is required");
  return {name:baseName(argv[0]),command:argv};
}

function profileStartupApps(profile){
  return Array.isArray(profile?.startup_apps)?profile.startup_apps:[];
}

function workspaceStatusObject(result){
  return result?.status??result?.json?.status??result?.json??result;
}

function workspaceStatusView(detail){
  var status=workspaceStatusObject(detail);
  if(!status||typeof status!=="object")return null;
  var apps=Array.isArray(status.apps)?status.apps:[];
  return h("section",{className:"rounded-md border border-token-border-default bg-token-main-surface-secondary p-3 text-sm"},
    h("div",{className:"mb-2 flex items-center justify-between gap-2"},
      h("div",{className:"font-medium text-token-text-primary"},"Workspace status"),
      status.ready?statusPill("Ready","active"):statusPill("Stopped","stopped")
    ),
    h("div",{className:"grid gap-2 text-token-text-secondary md:grid-cols-2"},
      h("div",null,"Display: "+(status.display||"unknown")),
      h("div",null,"Apps: "+apps.length),
      h("div",null,"Size: "+((status.width||"?")+" x "+(status.height||"?"))),
      h("div",{className:"truncate"},"Socket: "+(status.socket_path||"unknown"))
    )
  );
}

function resultView(result,open,setOpen){
  if(!result)return null;
  var border=result.ok?"border-token-border-default":"border-token-error";
  return h("details",{
    open:!!open,
    onToggle:function(event){setOpen(event.currentTarget.open);},
    className:"rounded-md border "+border+" bg-token-main-surface-secondary text-sm text-token-text-secondary"
  },
    h("summary",{className:"flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-token-text-primary"},
      h("span",null,result.ok===false?"Error":"Result"),
      h("span",{className:"truncate text-xs text-token-text-tertiary"},resultSummary(result))
    ),
    open?h("pre",{className:"max-h-[260px] overflow-auto border-t border-token-border-default p-3 text-xs text-token-text-secondary"},pretty(result.json??result)):null
  );
}

function workspaceId(workspace){
  return workspace?.id||workspace?.status?.id||workspace?.manifest?.id||workspace?.runtime_dir||"workspace";
}

function workspaceDetailId(detail){
  var status=workspaceStatusObject(detail);
  return status&&typeof status==="object"?workspaceId(status):null;
}

function workspaceRunning(workspace){
  return workspace?.running===true||workspace?.status?.ready===true;
}

function workspaceSummary(workspace){
  var status=workspace?.status;
  if(typeof workspace?.profile_id==="string"&&workspace.profile_id)return workspace.profile_id;
  if(typeof workspace?.purpose==="string"&&workspace.purpose)return workspace.purpose;
  if(status&&typeof status==="object"){
    if(typeof status.profile_id==="string"&&status.profile_id)return status.profile_id;
    if(typeof status.purpose==="string"&&status.purpose)return status.purpose;
    if(typeof status.id==="string"&&status.id)return status.id;
    return status.ready?"ready":"workspace";
  }
  if(typeof status==="string"&&status)return status;
  return workspace?.running?"running":"workspace";
}

function workspacePrimary(workspace){
  var summary=workspaceSummary(workspace);
  return summary&&summary!=="workspace"?summary:workspaceId(workspace);
}

function workspaceSecondary(workspace){
  var id=workspaceId(workspace);
  var primary=workspacePrimary(workspace);
  return id&&id!==primary?id:null;
}

function workspaceProfileId(workspace){
  return workspace?.profile_id||workspace?.status?.profile_id||workspace?.manifest?.profile_id||null;
}

function workspacePurpose(workspace){
  return workspace?.purpose||workspace?.status?.purpose||workspace?.manifest?.purpose||workspacePrimary(workspace);
}

function workspaceIdFromStartResponse(response,fallback){
  var json=response?.json;
  return json?.workspace_id||json?.workspaceId||json?.status?.id||json?.start?.status?.id||json?.start?.workspace_id||fallback||null;
}

function profileId(profile){
  return profile?.id||profile?.profile_id||"profile";
}

function profileSummary(profile){
  return profile?.description||profile?.cwd||"Saved profile";
}

function cleanupProcessActionCount(cleanup){
  var entries=[cleanup?.removed,cleanup?.candidates,cleanup?.skipped].flatMap(function(value){return Array.isArray(value)?value:[];});
  return entries.reduce(function(count,entry){return count+(Array.isArray(entry?.process_cleanup)?entry.process_cleanup.length:0);},0);
}

function resultSummary(result){
  if(result.ok===false)return result.message||result.stderr||"Command failed";
  if(Array.isArray(result.json?.workspaces)){
    var running=result.json.workspaces.filter(workspaceRunning).length;
    return "Workspace list: "+running+" active, "+(result.json.workspaces.length-running)+" stopped";
  }
  if(Array.isArray(result.json?.profiles))return "Profile list: "+result.json.profiles.length+" saved";
  if(Array.isArray(result.json?.removed)||Array.isArray(result.json?.candidates)){
    var removed=Array.isArray(result.json.removed)?result.json.removed.length:0;
    var candidates=Array.isArray(result.json.candidates)?result.json.candidates.length:0;
    var skipped=Array.isArray(result.json.skipped)?result.json.skipped.length:0;
    var processActions=cleanupProcessActionCount(result.json);
    var processText=processActions>0?", "+processActions+" process action"+(processActions===1?"":"s"):"";
    return result.json.dry_run?"Cleanup preview: "+candidates+" stale"+processText:"Cleanup: "+removed+" removed, "+skipped+" skipped"+processText;
  }
  if(result.action)return result.action+" complete";
  return "Command complete";
}

function statusPill(label,tone,showDot){
  var toneClass=tone==="active"?"border-green-500/40 text-green-700 dark:text-green-300":tone==="stopped"?"border-red-500/40 text-red-700 dark:text-red-300":tone==="warn"?"border-yellow-500/40 text-yellow-700 dark:text-yellow-300":"border-token-border-default text-token-text-tertiary";
  return h("span",{className:"inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs "+toneClass},showDot?statusDot(tone):null,label);
}

function statusDot(tone){
  var dotClass=tone==="active"?"bg-green-500":tone==="stopped"?"bg-red-500":tone==="warn"?"bg-yellow-400":"bg-gray-400";
  return h("span",{className:"inline-block h-2.5 w-2.5 shrink-0 rounded-full "+dotClass,"aria-hidden":true});
}

function activeWorkspaceFromList(workspaces){
  return (Array.isArray(workspaces)?workspaces:[]).find(workspaceRunning)||null;
}

function permissionConfigView(config){
  if(!config)return null;
  var locked=config.restricted===true;
  var hasPermissionFile=!!config.permissions_path;
  var label=config.configured==null?"Checking":locked?"Locked":"Session controlled";
  var detail=config.permissions_path||(config.configured===false?"No workspace permission file is active":config.message||config.config_path||"No workspace permission file");
  return h("div",{className:"rounded-md border border-token-border-default bg-token-bg-primary p-3 text-sm"},
    h("div",{className:"mb-1 flex items-center justify-between gap-2"},
      h("span",{className:"font-medium text-token-text-primary"},"Workspace permissions"),
      statusPill(label,locked?"warn":"idle")
    ),
    h("div",{className:"truncate text-token-text-tertiary",title:String(detail||"")},detail),
    locked?h("div",{className:"mt-2 text-xs text-token-text-secondary"},"A permission file is active for Agent Workspace actions. Use Reconnect after changing it."):null,
    hasPermissionFile&&!locked?h("div",{className:"mt-2 text-xs text-token-text-secondary"},"The permission file is open. Codex session permissions apply after hidden-workspace approval."):null,
    !hasPermissionFile&&!locked?h("div",{className:"mt-2 text-xs text-token-text-secondary"},"Codex session permissions apply after hidden-workspace approval."):null,
    config.error?h("div",{className:"mt-2 text-xs text-red-600 dark:text-red-300"},config.error):null
  );
}

function permissionsPathFromArgs(args){
  if(!Array.isArray(args))return null;
  for(var index=0;index<args.length;index+=1){
    var value=args[index];
    if(value==="--permissions"&&typeof args[index+1]==="string"&&args[index+1].trim())return args[index+1].trim();
    if(typeof value==="string"&&value.startsWith("--permissions=")){
      var path=value.slice("--permissions=".length).trim();
      if(path)return path;
    }
  }
  return null;
}

function permissionConfigFromResponses(permissionResponse,commandResponse){
  if(permissionResponse?.json&&typeof permissionResponse.json==="object")return permissionResponse.json;
  var permissionsPath=permissionsPathFromArgs(commandResponse?.args);
  if(permissionsPath)return{
    configured:true,
    restricted:true,
    permissions_path:permissionsPath,
    message:"Permission file is active for workspace actions"
  };
  if(permissionResponse&&permissionResponse.ok===false)return{
    configured:false,
    restricted:false,
    message:permissionResponse.message||"Workspace permissions could not be inspected",
    error:permissionResponse.message||null
  };
  return null;
}

function smokeCheck(response){
  return {
    action:response?.action||"unknown",
    ok:responseOk(response),
    summary:resultSummary(response),
    message:response?.message||null
  };
}

function smokeResultFromResponses(responses){
  return {
    ok:responses.every(responseOk),
    action:"smoke",
    json:{checks:responses.map(smokeCheck)}
  };
}

function approvalPreviewFromResponse(response){
  var json=response?.json;
  if(!json||typeof json!=="object")return null;
  return json.start_preview||json.startPreview||json.launch_preview||json.launchPreview||json.run_preview||json.runPreview||json;
}

function approvalBundleFromResponse(response){
  var json=response?.json;
  var preview=approvalPreviewFromResponse(response);
  var candidates=[json?.approval_bundle,json?.approvalBundle,json?.approval,preview?.approval];
  return candidates.find(function(value){
    return value&&typeof value==="object"&&!Array.isArray(value);
  })||null;
}

function approvalRequirementLabels(bundle){
  var requirements=Array.isArray(bundle?.missing_acknowledgements)&&bundle.missing_acknowledgements.length>0
    ? bundle.missing_acknowledgements
    : Array.isArray(bundle?.required_acknowledgements)?bundle.required_acknowledgements:[];
  return requirements.map(function(requirement){return requirement?.label||requirement?.id;}).filter(Boolean);
}

function pendingApprovalSummary(pending){
  var preview=approvalPreviewFromResponse(pending?.preview);
  var bundle=approvalBundleFromResponse(pending?.preview);
  var params=pending?.params||{};
  var profile=params.profileId||preview?.profile_id||preview?.profile||"none";
  var purpose=params.purpose||preview?.purpose||"Codex agent workspace";
  var request=bundle?.subject||preview?.message||pending?.title||"Start hidden workspace";
  var requirements=approvalRequirementLabels(bundle);
  return {
    request,
    profile,
    purpose,
    requirements,
    runSetup:!!params.runSetup,
    waitWindow:!!params.startupWaitWindow,
    screenshotWindow:!!params.startupScreenshotWindow
  };
}

function approvalPreviewView(pending,onApprove,onCancel){
  if(!pending)return null;
  var summary=pendingApprovalSummary(pending);
  return h("section",{className:"rounded-md border border-yellow-500/40 bg-token-main-surface-secondary p-3 text-sm shadow-sm"},
    h("div",{className:"flex items-start justify-between gap-3"},
      h("div",{className:"min-w-0"},
        h("div",{className:"font-medium text-token-text-primary"},"Approve hidden workspace"),
        h("div",{className:"mt-1 text-token-text-secondary"},"Codex wants to start an agent-controlled Linux workspace that is separate from your visible desktop."),
        h("div",{className:"mt-1 text-token-text-secondary"},RUNS_AS_YOU_TEXT),
        h("div",{className:"mt-1 text-token-text-secondary"},"The native GPUI viewer opens after the workspace starts.")
      ),
      statusPill("Approval required","warn")
    ),
    h("div",{className:"mt-3 grid gap-2 text-token-text-secondary md:grid-cols-2"},
      h("div",{className:"truncate",title:summary.request},"Request: "+summary.request),
      h("div",{className:"truncate",title:summary.profile},"Profile: "+summary.profile),
      h("div",{className:"truncate",title:summary.purpose},"Purpose: "+summary.purpose),
      h("div",null,"Setup: "+(summary.runSetup?"Run before startup":"Skip")),
      h("div",null,"Startup windows: "+(summary.waitWindow?"Wait for first window":"Do not wait")),
      h("div",null,"Screenshots: "+(summary.screenshotWindow?"Capture startup window":"Not requested"))
    ),
    summary.requirements.length>0
      ? h("div",{className:"mt-3 rounded-md border border-token-border-default p-2 text-token-text-secondary"},
          h("div",{className:"mb-1 text-xs font-medium uppercase tracking-normal text-token-text-tertiary"},"Acknowledgements"),
          summary.requirements.map(function(label){return h("div",{key:label},"- "+label);})
        )
      : null,
    h("div",{className:"mt-3 flex flex-wrap justify-end gap-2"},
      button("Cancel",false,onCancel),
      button("Approve and start",false,onApprove)
    )
  );
}

function AgentWorkspacesSettings(){
  var commandState=React.useState("");
  var command=commandState[0];
  var setCommand=commandState[1];
  var permissionsPathState=React.useState("");
  var permissionsPath=permissionsPathState[0];
  var setPermissionsPath=permissionsPathState[1];
  var permissionDraftState=React.useState(defaultPermissions);
  var permissionDraft=permissionDraftState[0];
  var setPermissionDraft=permissionDraftState[1];
  var permissionAppState=React.useState("");
  var permissionApp=permissionAppState[0];
  var setPermissionApp=permissionAppState[1];
  var profileState=React.useState([]);
  var profiles=profileState[0];
  var setProfiles=profileState[1];
  var workspaceState=React.useState([]);
  var workspaces=workspaceState[0];
  var setWorkspaces=workspaceState[1];
  var permissionConfigState=React.useState({configured:null,restricted:false,message:"Checking workspace permissions"});
  var permissionConfig=permissionConfigState[0];
  var setPermissionConfig=permissionConfigState[1];
  var selectedState=React.useState("");
  var selectedProfileId=selectedState[0];
  var setSelectedProfileId=selectedState[1];
  var profileJsonState=React.useState(function(){return pretty(defaultProfile());});
  var profileJson=profileJsonState[0];
  var setProfileJson=profileJsonState[1];
  var resultState=React.useState(null);
  var result=resultState[0];
  var setResult=resultState[1];
  var resultOpenState=React.useState(false);
  var resultOpen=resultOpenState[0];
  var setResultOpen=resultOpenState[1];
  var advancedOpenState=React.useState(false);
  var advancedOpen=advancedOpenState[0];
  var setAdvancedOpen=advancedOpenState[1];
  var actionState=React.useState(null);
  var activeAction=actionState[0];
  var setActiveAction=actionState[1];
  var purposeState=React.useState("");
  var purpose=purposeState[0];
  var setPurpose=purposeState[1];
  var loadingState=React.useState(true);
  var loading=loadingState[0];
  var setLoading=loadingState[1];
  var editingState=React.useState(false);
  var editingProfile=editingState[0];
  var setEditingProfile=editingState[1];
  var manualAppState=React.useState("");
  var manualApp=manualAppState[0];
  var setManualApp=manualAppState[1];
  var formModeState=React.useState("create");
  var formMode=formModeState[0];
  var setFormMode=formModeState[1];
  var detailState=React.useState(null);
  var workspaceDetail=detailState[0];
  var setWorkspaceDetail=detailState[1];
  var browserSessionState=React.useState(null);
  var browserSessionDraft=browserSessionState[0];
  var setBrowserSessionDraft=browserSessionState[1];
  var versionGateState=React.useState({status:"checking",installed:null});
  var versionGate=versionGateState[0];
  var setVersionGate=versionGateState[1];
  var pendingApprovalState=React.useState(null);
  var pendingApproval=pendingApprovalState[0];
  var setPendingApproval=pendingApprovalState[1];

  var callAgentWorkspace=React.useCallback(async function(action,params){
    setActiveAction(action);
    try{
      var response=await __post("linux-agent-workspace",{params:{action:action,...(params||{})}});
      setResult(response);
      setResultOpen(false);
      return response;
    }catch(error){
      var response={ok:false,action:action,message:error instanceof Error?error.message:String(error)};
      setResult(response);
      setResultOpen(false);
      return response;
    }finally{
      setActiveAction(null);
    }
  },[]);

  var refresh=React.useCallback(async function(){
    var responses=await Promise.all([
      callAgentWorkspace("permissionConfig"),
      callAgentWorkspace("profileList"),
      callAgentWorkspace("workspaceList")
    ]);
    var nextPermissionConfig=permissionConfigFromResponses(responses[0],responses[2]);
    setPermissionConfig(nextPermissionConfig||{configured:false,restricted:false,message:"No workspace permission file detected; Codex session permissions apply"});
    setPermissionDraft(permissionsFromConfig(nextPermissionConfig));
    if(Array.isArray(responses[1]?.json?.profiles))setProfiles(responses[1].json.profiles);
    if(Array.isArray(responses[2]?.json?.workspaces))setWorkspaces(responses[2].json.workspaces);
  },[callAgentWorkspace]);

  React.useEffect(function(){
    var alive=true;
    __post("${GLOBAL_STATE_GET_METHOD}",{params:{key:COMMAND_KEY}})
      .then(function(response){if(alive)setCommand(response?.value??"");})
      .catch(function(){});
    __post("${GLOBAL_STATE_GET_METHOD}",{params:{key:PERMISSIONS_KEY}})
      .then(function(response){if(alive)setPermissionsPath(response?.value??"");})
      .catch(function(){});
    Promise.all([refresh(),checkVersion()]).finally(function(){if(alive)setLoading(false);});
    return function(){alive=false;};
  },[refresh]);

  var profile=parseProfile(profileJson);
  var startupApps=profileStartupApps(profile);
  var permissionPolicy=normalizePermissions(permissionDraft);
  var permissionApps=permissionPolicy.apps.allow;
  var runningWorkspaces=workspaces.filter(workspaceRunning);
  var activeWorkspace=activeWorkspaceFromList(workspaces);
  var otherRunningWorkspaces=activeWorkspace?runningWorkspaces.slice(1):[];
  var stoppedWorkspaces=workspaces.filter(function(workspace){return !workspaceRunning(workspace);});
  var stoppedWorkspaceCount=stoppedWorkspaces.length;
  var editingSaved=formMode==="edit"&&!!selectedProfileId;
  var selectedProfileActive=editingSaved&&runningWorkspaces.some(function(workspace){return workspaceProfileId(workspace)===selectedProfileId||workspacePrimary(workspace)===selectedProfileId;});
  var profileFormLocked=selectedProfileActive;
  var versionBlocked=versionGate.status!=="ok";
  var startDisabled=versionBlocked||!profile||!!activeWorkspace||!!pendingApproval||activeAction==="workspaceOpenProfile"||activeAction==="workspaceStart";

  async function saveCommand(){
    await __post("${GLOBAL_STATE_SET_METHOD}",{params:{key:COMMAND_KEY,value:command.trim()||void 0}});
    await reconnectBackend();
  }

  async function savePermissions(){
    await __post("${GLOBAL_STATE_SET_METHOD}",{params:{key:PERMISSIONS_KEY,value:permissionsPath.trim()||void 0}});
    await reconnectBackend();
  }

  async function savePermissionRules(){
    var response=await callAgentWorkspace("permissionSave",{permissions:permissionPolicy});
    if(response?.json?.permissions_path)setPermissionsPath(response.json.permissions_path);
    if(response?.json)setPermissionConfig(response.json);
    if(response?.json?.ceiling)setPermissionDraft(permissionsFromConfig(response.json));
    var doctor=await callAgentWorkspace("doctor");
    await refresh();
    setResult({ok:response?.ok!==false&&doctor?.ok!==false,action:"permissionSave",json:{permissions:response?.json??response,doctor:doctor?.json??doctor,reconnected:true}});
    setResultOpen(false);
  }

  async function clearPermissions(){
    setPermissionsPath("");
    await __post("${GLOBAL_STATE_SET_METHOD}",{params:{key:PERMISSIONS_KEY,value:void 0}});
    await reconnectBackend();
  }

  async function checkVersion(){
    var gate=versionGateFromResponse(await callAgentWorkspace("version"));
    setVersionGate(gate);
    return gate;
  }

  async function reconnectBackend(){
    var gate=await checkVersion();
    var doctor=await callAgentWorkspace("doctor");
    await refresh();
    setResult({ok:gate.status==="ok"&&doctor?.ok!==false,action:"reconnect",message:gate.status==="ok"?void 0:versionGateMessage(gate),json:{version:gate,doctor:doctor?.json??doctor,refreshed:true}});
    setResultOpen(false);
  }

  async function installRuntime(){
    var install=await callAgentWorkspace("installRuntime",{timeoutMs:300000});
    if(install?.ok===false)return;
    var installedCommand=install?.json?.command;
    if(typeof installedCommand!=="string"||!installedCommand.trim()){
      setResult({ok:false,action:"installRuntime",message:"npm did not report the installed executable path",json:install});
      return;
    }
    await __post("${GLOBAL_STATE_SET_METHOD}",{params:{key:COMMAND_KEY,value:installedCommand}});
    setCommand(installedCommand);
    var gate=await checkVersion();
    var doctor=await callAgentWorkspace("doctor");
    await refresh();
    setResult({ok:gate.status==="ok"&&doctor?.ok!==false,action:"installRuntime",message:gate.status==="ok"?void 0:versionGateMessage(gate),json:{install:install,version:gate,doctor:doctor?.json??doctor,refreshed:true}});
    setResultOpen(false);
  }

  async function runBackendSmoke(){
    var gate=await checkVersion();
    var responses=[{action:"version",ok:gate.status==="ok",message:gate.status==="ok"?void 0:versionGateMessage(gate),json:gate}];
    for(var action of ["doctor","guardrails","profilePath","profileList","workspaceList","permissionConfig"]){
      responses.push(await callAgentWorkspace(action));
    }
    var nextPermissionConfig=permissionConfigFromResponses(responses[6],responses[5]);
    setPermissionConfig(nextPermissionConfig||{configured:false,restricted:false,message:"No workspace permission file detected; Codex session permissions apply"});
    if(Array.isArray(responses[4]?.json?.profiles))setProfiles(responses[4].json.profiles);
    if(Array.isArray(responses[5]?.json?.workspaces))setWorkspaces(responses[5].json.workspaces);
    setResult(smokeResultFromResponses(responses));
    setResultOpen(true);
  }

  function updatePermissionDraft(mutator){
    setPermissionDraft(function(current){
      var next=JSON.parse(JSON.stringify(normalizePermissions(current)));
      mutator(next);
      return normalizePermissions(next);
    });
  }

  function addPermissionApp(entry){
    var value=String(entry||permissionApp).trim();
    if(!value)return;
    updatePermissionDraft(function(next){
      var apps=next.apps&&typeof next.apps==="object"?next.apps:{allow:[]};
      var allow=Array.isArray(apps.allow)?apps.allow:[];
      next.apps={...apps,allow:allow.includes(value)?allow:[...allow,value]};
    });
    setPermissionApp("");
  }

  function removePermissionApp(index){
    updatePermissionDraft(function(next){
      var apps=next.apps&&typeof next.apps==="object"?next.apps:{allow:[]};
      var allow=Array.isArray(apps.allow)?apps.allow:[];
      next.apps={...apps,allow:allow.filter(function(_,appIndex){return appIndex!==index;})};
    });
  }

  async function pickPermissionApp(){
    try{
      var response=await __post("linux-agent-workspace-pick-app",{params:{}});
      setResult(response);
      var command=response?.json?.startup_app?.command;
      if(response?.ok&&Array.isArray(command)&&command[0])addPermissionApp(command[0]);
      else if(response?.ok&&response?.json?.path)addPermissionApp(response.json.path);
    }catch(error){
      setResult({ok:false,action:"pickPermissionApp",message:error instanceof Error?error.message:String(error)});
    }
  }

  function updateProfile(mutator){
    var next=parseProfile(profileJson)||defaultProfile();
    mutator(next);
    setProfileJson(pretty(next));
  }

  function selectProfile(profileId,openEditor){
    setSelectedProfileId(profileId);
    if(openEditor){
      setFormMode("edit");
      setAdvancedOpen(false);
      setEditingProfile(true);
    }
    if(!profileId)return;
    callAgentWorkspace("profileGet",{profileId:profileId}).then(function(response){
      var loaded=profileFromResponse(response);
      if(loaded)setProfileJson(pretty(loaded));
    });
  }

  function createProfile(){
    setFormMode("create");
    setSelectedProfileId("");
    setProfileJson(pretty(defaultProfile()));
    setPurpose("");
    setManualApp("");
    setAdvancedOpen(false);
    setEditingProfile(true);
  }

  function uniqueProfileId(base){
    var existing=new Set(profiles.map(profileId));
    if(!existing.has(base))return base;
    var index=2;
    while(existing.has(base+"-"+index))index+=1;
    return base+"-"+index;
  }

  async function createProjectProfile(){
    try{
      var pick=await __post("linux-agent-workspace-pick-project",{params:{}});
      setResult(pick);
      var hostPath=pick?.json?.path;
      if(!pick?.ok||!hostPath)return;
      var base=hostPath.split(/[\\/]+/).filter(Boolean).pop()||"project-dev";
      var id=uniqueProfileId(base.toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"project-dev");
      var response=await callAgentWorkspace("profileTemplate",{templateKind:"project-dev",profileId:id,hostPath:hostPath});
      var template=profileFromResponse(response);
      openCreateProfileTemplate(template);
    }catch(error){
      setResult({ok:false,action:"pickProject",message:error instanceof Error?error.message:String(error)});
    }
  }

  async function createChromeProfile(){
    var id=uniqueProfileId("chrome");
    var response=await callAgentWorkspace("profileTemplate",{templateKind:"chrome",profileId:id});
    var template=profileFromResponse(response);
    openCreateProfileTemplate(template);
  }

  async function createBrowserSessionProfile(){
    try{
      var pick=await __post("linux-agent-workspace-pick-browser-data",{params:{}});
      setResult(pick);
      var dataDir=pick?.json?.path;
      if(!pick?.ok||!dataDir)return;
      setBrowserSessionDraft({sourcePath:dataDir,profileId:uniqueProfileId("browser-session"),useCopy:true});
      setEditingProfile(false);
    }catch(error){
      setResult({ok:false,action:"pickBrowserData",message:error instanceof Error?error.message:String(error)});
    }
  }

  function updateBrowserSessionDraft(mutator){
    setBrowserSessionDraft(function(current){
      if(!current)return current;
      var next={...current};
      mutator(next);
      return next;
    });
  }

  async function finishBrowserSessionProfile(){
    if(!browserSessionDraft?.sourcePath||!browserSessionDraft?.profileId)return;
    var dataDir=browserSessionDraft.sourcePath;
    if(browserSessionDraft.useCopy){
      var copy=await __post("linux-agent-workspace-copy-browser-data",{params:{sourcePath:browserSessionDraft.sourcePath,profileId:browserSessionDraft.profileId}});
      setResult(copy);
      if(!copy?.ok||!copy?.json?.path)return;
      dataDir=copy.json.path;
    }else if(!window.confirm("Run Chrome directly on this browser data folder? Close the host browser first: agent-workspace-linux refuses a profile a desktop browser holds, because the window would open on your desktop.")){
      return;
    }
    var response=await callAgentWorkspace("profileTemplate",{templateKind:"browser-session",profileId:browserSessionDraft.profileId,userDataDir:dataDir});
    var template=profileFromResponse(response);
    if(template&&browserSessionDraft.useCopy){
      template.description=(template.description||"Browser session profile")+" Managed copy from "+browserSessionDraft.sourcePath+".";
    }
    if(template){
      setBrowserSessionDraft(null);
      openCreateProfileTemplate(template);
    }
  }

  function openCreateProfileTemplate(template){
    if(template){
      setFormMode("create");
      setSelectedProfileId("");
      setProfileJson(pretty(template));
      setPurpose("");
      setManualApp("");
      setAdvancedOpen(false);
      setEditingProfile(true);
    }
  }

  function setProfileTextField(key,value){
    updateProfile(function(next){
      if(value.trim())next[key]=value;
      else delete next[key];
    });
  }

  function addStartupApp(app){
    if(!app?.command?.length)return;
    updateProfile(function(next){next.startup_apps=[...profileStartupApps(next),app];});
  }

  function removeStartupApp(index){
    updateProfile(function(next){next.startup_apps=profileStartupApps(next).filter(function(_,appIndex){return appIndex!==index;});});
  }

  async function pickStartupApp(){
    try{
      var response=await __post("linux-agent-workspace-pick-app",{params:{}});
      setResult(response);
      if(response?.ok&&response?.json?.startup_app)addStartupApp(response.json.startup_app);
      else if(response?.ok&&response?.json?.path)addStartupApp(startupAppFromPath(response.json.path));
    }catch(error){
      setResult({ok:false,action:"pickStartupApp",message:error instanceof Error?error.message:String(error)});
    }
  }

  function addManualStartupApp(){
    if(!manualApp.trim())return;
    try{
      addStartupApp(startupAppFromManual(manualApp));
      setManualApp("");
    }catch(error){
      setResult({ok:false,action:"manualStartupApp",message:error instanceof Error?error.message:String(error)});
    }
  }

  async function saveProfile(replace){
    if(!profile){
      setResult({ok:false,message:"Profile JSON is invalid"});
      return;
    }
    if(profileFormLocked){
      setResult({ok:false,message:"Stop the active workspace before editing this saved profile"});
      return;
    }
    var response=await callAgentWorkspace("profileSave",{profile:profile,replace:replace});
    if(response?.ok){
      setSelectedProfileId(profile.id||"");
      setEditingProfile(false);
      refresh();
    }
  }

  function previewStart(){
    if(!profile?.id)return;
    setSelectedProfileId(profile.id);
    callAgentWorkspace("workspaceOpenProfile",{
      profileId:profile.id,
      dryRun:true,
      purpose:purpose||"Codex agent workspace",
      runSetup:true,
      startupWaitWindow:true
    });
  }

  async function requestStartApproval(action,params,title){
    if(versionBlocked||activeWorkspace||pendingApproval)return;
    var preview=await callAgentWorkspace(action,{...params,dryRun:true});
    if(!responseOk(preview))return;
    setPendingApproval({action:action,params:params,preview:preview,title:title});
  }

  async function approvePendingStart(){
    var pending=pendingApproval;
    if(!pending||versionBlocked)return;
    setPendingApproval(null);
    var startResponse=await callAgentWorkspace(pending.action,{...pending.params,ackHiddenWorkspace:true});
    if(responseOk(startResponse)){
      var startedId=workspaceIdFromStartResponse(startResponse,pending.params?.workspaceId);
      if(startedId){
        var viewerResponse=await callAgentWorkspace("workspaceOpenViewer",{workspaceId:startedId});
        setResult({
          ok:viewerResponse?.ok!==false,
          action:pending.action,
          message:resultSummary(startResponse)+"; viewer "+(viewerResponse?.ok===false?"failed":"opened"),
          json:{start:startResponse.json,viewer:viewerResponse?.json}
        });
        setResultOpen(false);
      }
    }
    refresh();
  }

  function startWorkspace(){
    if(!profile?.id||activeWorkspace)return;
    requestStartApproval("workspaceOpenProfile",{
      profileId:profile.id,
      purpose:purpose||"Codex agent workspace",
      runSetup:true,
      startupWaitWindow:true
    },"Start "+profile.id);
  }

  function startSavedWorkspace(savedProfile){
    var id=profileId(savedProfile);
    if(!id||activeWorkspace)return;
    requestStartApproval("workspaceOpenProfile",{
      profileId:id,
      purpose:profileSummary(savedProfile)||"Codex agent workspace",
      runSetup:true,
      startupWaitWindow:true
    },"Start "+id);
  }

  function stopWorkspace(workspaceId){
    callAgentWorkspace("workspaceStop",{workspaceId:workspaceId}).then(function(){
      setWorkspaceDetail(null);
      refresh();
    });
  }

  function openWorkspaceViewer(workspaceId){
    callAgentWorkspace("workspaceOpenViewer",{workspaceId:workspaceId});
  }

  function startStoppedWorkspace(workspace){
    if(activeWorkspace)return;
    requestStartApproval("workspaceStart",{
      workspaceId:workspaceId(workspace),
      profileId:workspaceProfileId(workspace),
      purpose:workspacePurpose(workspace)||"Codex agent workspace"
    },"Restart "+workspacePrimary(workspace));
  }

  function deleteStoppedWorkspace(workspace){
    var id=workspaceId(workspace);
    if(!window.confirm("Delete stopped workspace "+id+"?"))return;
    callAgentWorkspace("workspaceCleanup",{cleanupId:id,dryRun:false}).then(function(){
      setWorkspaceDetail(null);
      refresh();
    });
  }

  function showWorkspaceStatus(workspaceId){
    if(workspaceDetailId(workspaceDetail)===workspaceId){
      setWorkspaceDetail(null);
      return;
    }
    callAgentWorkspace("workspaceStatus",{workspaceId:workspaceId}).then(function(response){
      if(response?.ok)setWorkspaceDetail(response);
    });
  }

  function cleanupStale(){
    if(!window.confirm("Remove stopped workspace runtime directories? Running workspaces are skipped."))return;
    callAgentWorkspace("workspaceCleanup",{dryRun:false}).then(function(){
      setWorkspaceDetail(null);
      refresh();
    });
  }

  return h(SettingsPage,{title:"Agent Workspaces",subtitle:"Linux agent environments"},
    h("div",{className:"flex max-w-5xl flex-col gap-5 p-1"},
      h("section",{className:"flex flex-col gap-2"},
        h("div",{className:"flex items-center justify-between gap-2"},
          h("div",{className:"text-sm font-medium text-token-text-primary"},"Workspace control"),
          h("div",{className:"flex gap-2"},
            button("Reconnect",!!activeAction||loading,reconnectBackend),
            button("Smoke test",!!activeAction||loading,runBackendSmoke),
            button("Refresh",activeAction==="profileList"||loading,refresh)
          )
        ),
        h("details",{className:"rounded-md border border-token-border-default bg-token-main-surface-secondary text-sm"},
          h("summary",{className:"flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-token-text-primary"},
            h("span",null,"Connection"),
            h("span",{className:"truncate text-xs text-token-text-tertiary"},command.trim()?"Custom command":DEFAULT_COMMAND_LABEL)
          ),
          h("div",{className:"grid gap-3 border-t border-token-border-default p-3"},
            h("div",{className:"grid gap-3 md:grid-cols-[1fr_auto]"},
              field("Command",command,setCommand,DEFAULT_COMMAND_LABEL),
              h("div",{className:"flex items-end"},button("Save",activeAction==="doctor",saveCommand))
            ),
            h("div",{className:"flex flex-wrap gap-2"},
              button("Install from npm",activeAction==="installRuntime",installRuntime)
            ),
            h("div",{className:"grid gap-3 md:grid-cols-[1fr_auto]"},
              field("Permission file",permissionsPath,setPermissionsPath,"/path/to/agent-workspace-permissions.json"),
              h("div",{className:"flex items-end gap-2"},
                button("Apply",activeAction==="doctor",savePermissions),
                button("Remove",activeAction==="doctor"||!permissionsPath.trim(),clearPermissions)
              )
            )
          )
        ),
        versionBlocked&&versionGate.status!=="checking"
          ? h("div",{className:"rounded-md border border-red-500/40 bg-token-main-surface-secondary p-3 text-sm text-red-700 dark:text-red-300",role:"alert"},versionGateMessage(versionGate))
          : null,
        permissionConfig?permissionConfigView(permissionConfig):null,
        h("section",{className:"rounded-md border border-token-border-default bg-token-main-surface-secondary p-3 text-sm"},
          h("div",{className:"mb-3 flex items-center justify-between gap-2"},
            h("div",{className:"font-medium text-token-text-primary"},"Permission rules"),
            h("div",{className:"flex gap-2"},
              statusPill(permissionApps.length===0?"Any app":permissionApps.length+" app"+(permissionApps.length===1?"":"s"),"idle"),
              button("Save permissions",versionBlocked||activeAction==="permissionSave",savePermissionRules)
            )
          ),
          h("div",{className:"text-sm text-token-text-secondary"},RUNS_AS_YOU_TEXT+" The app allowlist limits what agents may launch."),
          h("div",{className:"mt-3 flex flex-col gap-2 rounded-md border border-token-border-default p-3"},
            h("div",{className:"flex items-center justify-between gap-2"},
              h("div",{className:"text-sm font-medium text-token-text-primary"},"Allowed apps"),
              button("Pick app",false,pickPermissionApp)
            ),
            permissionApps.length===0
              ? h("div",{className:"rounded-md border border-dashed border-token-border-default p-2 text-sm text-token-text-tertiary"},"No app allowlist: agents may launch any app")
              : h("div",{className:"flex flex-col gap-2"},
                  permissionApps.map(function(app,index){
                    return h("div",{key:app+"-"+index,className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2 text-sm"},
                      h("div",{className:"truncate text-token-text-primary"},app),
                      button("Remove",false,function(){removePermissionApp(index);})
                    );
                  })
                ),
            h("div",{className:"grid gap-2 md:grid-cols-[1fr_auto]"},
              field("App command",permissionApp,setPermissionApp,"/usr/bin/google-chrome"),
              h("div",{className:"flex items-end"},button("Add app",!permissionApp.trim(),function(){addPermissionApp();}))
            )
          )
        )
      ),

      h("section",{className:"flex flex-col gap-2"},
        h("div",{className:"flex items-center justify-between"},
          h("div",{className:"text-sm font-medium text-token-text-primary"},"Active workspace"),
          activeWorkspace?statusPill("Active","active",true):statusPill("Idle","idle")
        ),
        activeWorkspace
          ? h("div",{className:"flex items-center justify-between gap-3 rounded-md border border-token-border-default p-3 text-sm"},
              h("div",{className:"min-w-0"},
                h("div",{className:"truncate text-token-text-primary"},workspacePrimary(activeWorkspace)),
                workspaceSecondary(activeWorkspace)?h("div",{className:"truncate text-token-text-tertiary"},workspaceSecondary(activeWorkspace)):null
              ),
              h("div",{className:"flex shrink-0 gap-2"},
                button("Open Viewer",activeAction==="workspaceOpenViewer",function(){openWorkspaceViewer(workspaceId(activeWorkspace));}),
                toggleButton(workspaceDetailId(workspaceDetail)===workspaceId(activeWorkspace)?"Hide status":"Status",workspaceDetailId(workspaceDetail)===workspaceId(activeWorkspace),false,function(){showWorkspaceStatus(workspaceId(activeWorkspace));}),
                button("Stop",false,function(){stopWorkspace(workspaceId(activeWorkspace));})
              )
            )
          : h("div",{className:"rounded-md border border-dashed border-token-border-default p-3 text-sm text-token-text-tertiary"},"No active workspace"),
        workspaceStatusView(workspaceDetail),
        approvalPreviewView(pendingApproval,approvePendingStart,function(){setPendingApproval(null);}),
        otherRunningWorkspaces.length>0
          ? h("details",{className:"rounded-md border border-yellow-500/30 bg-token-main-surface-secondary text-sm"},
              h("summary",{className:"cursor-pointer px-3 py-2 text-token-text-primary"},"Other running workspaces ("+otherRunningWorkspaces.length+")"),
              h("div",{className:"flex flex-col gap-2 border-t border-token-border-default p-2"},
                otherRunningWorkspaces.map(function(workspace){
                  var id=workspaceId(workspace);
                  return h("div",{key:id,className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2"},
                    h("div",{className:"min-w-0"},
                      h("div",{className:"truncate text-token-text-primary"},workspacePrimary(workspace)),
                      workspaceSecondary(workspace)?h("div",{className:"truncate text-token-text-tertiary"},workspaceSecondary(workspace)):null
                    ),
                    h("div",{className:"flex shrink-0 gap-2"},
                      button("Open Viewer",activeAction==="workspaceOpenViewer",function(){openWorkspaceViewer(id);}),
                      button("Stop",false,function(){stopWorkspace(id);})
                    )
                  );
                })
              )
            )
          : null,
        stoppedWorkspaceCount>0
          ? h("details",{className:"rounded-md border border-token-border-default bg-token-main-surface-secondary text-sm"},
              h("summary",{className:"flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-token-text-primary"},
                h("span",{className:"flex items-center gap-2"},statusDot("stopped"),"Stopped workspaces ("+stoppedWorkspaceCount+")"),
                h("span",{className:"text-xs text-token-text-tertiary"},"Open")
              ),
              h("div",{className:"flex flex-col gap-2 border-t border-token-border-default p-2"},
                stoppedWorkspaces.map(function(workspace){
                  var id=workspaceId(workspace);
                  return h("div",{key:id,className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2"},
                    h("div",{className:"min-w-0"},
                      h("div",{className:"truncate text-token-text-primary"},workspacePrimary(workspace)),
                      workspaceSecondary(workspace)?h("div",{className:"truncate text-token-text-tertiary"},workspaceSecondary(workspace)):null
                    ),
                    h("div",{className:"flex shrink-0 gap-2"},
                      button("Open Viewer",activeAction==="workspaceOpenViewer",function(){openWorkspaceViewer(id);}),
                      button("Start",versionBlocked||!!activeWorkspace||activeAction==="workspaceStart"||activeAction==="workspaceOpenProfile",function(){startStoppedWorkspace(workspace);}),
                      button("Delete",activeAction==="workspaceCleanup",function(){deleteStoppedWorkspace(workspace);})
                    )
                  );
                }),
                h("div",{className:"flex justify-end"},button("Delete stale",activeAction==="workspaceCleanup",cleanupStale))
              )
            )
          : null
      ),

      h("section",{className:"flex flex-col gap-3"},
        h("div",{className:"flex items-center justify-between"},
          h("div",{className:"text-sm font-medium text-token-text-primary"},"Saved workspaces"),
          h("div",{className:"flex gap-2"},
            button("Project template",versionBlocked||activeAction==="profileTemplate",createProjectProfile),
            button("Chrome template",versionBlocked||activeAction==="profileTemplate",createChromeProfile),
            button("Browser session",versionBlocked||activeAction==="profileTemplate",createBrowserSessionProfile),
            button("Create new",false,createProfile)
          )
        ),
        profiles.length===0
          ? h("div",{className:"rounded-md border border-dashed border-token-border-default p-3 text-sm text-token-text-tertiary"},"No saved workspaces")
          : h("div",{className:"grid gap-2 md:grid-cols-2"},
              profiles.map(function(savedProfile){
                var id=profileId(savedProfile);
                var selected=id===selectedProfileId;
                var activeForProfile=runningWorkspaces.some(function(workspace){return workspaceProfileId(workspace)===id||workspacePrimary(workspace)===id;});
                return h("div",{
                  key:id,
                  className:"rounded-md border p-3 text-sm "+(selected?"border-token-border-strong bg-token-main-surface-secondary":"border-token-border-default")
                },
                  h("div",{className:"flex items-center justify-between gap-2"},
                    h("span",{className:"truncate font-medium text-token-text-primary"},id),
                    activeForProfile?statusPill("Active","active",true):null
                  ),
                  h("div",{className:"mt-1 truncate text-token-text-tertiary"},profileSummary(savedProfile)),
                  h("div",{className:"mt-3 flex gap-2"},
                    button(activeForProfile?"Running":"Start",versionBlocked||!!activeWorkspace||activeAction==="workspaceOpenProfile",function(){startSavedWorkspace(savedProfile);}),
                    button(activeForProfile?"Stop to edit":"Edit saved",activeForProfile,function(){selectProfile(id,true);}),
                    button("Delete",activeForProfile,function(){
                      if(window.confirm("Delete profile "+id+"?"))callAgentWorkspace("profileDelete",{profileId:id}).then(refresh);
                    })
                  )
                );
              })
            )
      ),

      browserSessionDraft
        ? h("div",{className:"fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4",role:"presentation"},
          h("section",{className:"mx-auto flex max-h-[calc(100vh-2rem)] max-w-2xl flex-col gap-3 overflow-y-auto rounded-md border border-token-border-default bg-token-bg-primary p-3 shadow-xl",role:"dialog","aria-modal":true},
            h("div",{className:"flex items-center justify-between gap-2"},
              h("div",{className:"text-sm font-medium text-token-text-primary"},"Prepare browser session"),
              statusPill("Account data","warn")
            ),
            h("div",{className:"rounded-md border border-yellow-500/30 bg-token-main-surface-secondary p-3 text-sm text-token-text-secondary"},"Browser profiles hold cookies and logged-in sessions, and Chrome in the workspace runs as you with them. A managed copy leaves your own browser profile alone and avoids profile locks; use the folder directly only for a dedicated browser profile."),
            field("Workspace name",browserSessionDraft.profileId,function(value){updateBrowserSessionDraft(function(next){next.profileId=value;});},"browser-session"),
            h("div",{className:"rounded-md border border-token-border-default p-3 text-sm"},
              h("div",{className:"mb-1 text-xs text-token-text-tertiary"},"Selected folder"),
              h("div",{className:"truncate text-token-text-primary",title:browserSessionDraft.sourcePath},browserSessionDraft.sourcePath)
            ),
            h("div",{className:"grid gap-2 md:grid-cols-2"},
              h("button",{
                type:"button",
                className:"rounded-md border p-3 text-left text-sm hover:bg-token-main-surface-secondary "+(browserSessionDraft.useCopy?"border-token-border-strong bg-token-main-surface-secondary":"border-token-border-default"),
                "aria-pressed":browserSessionDraft.useCopy,
                onClick:function(){updateBrowserSessionDraft(function(next){next.useCopy=true;});}
              },
                h("div",{className:"font-medium text-token-text-primary"},"Copy profile"),
                h("div",{className:"mt-1 text-xs text-token-text-secondary"},"Creates a managed copy under Agent Workspace data and skips browser lock files.")
              ),
              h("button",{
                type:"button",
                className:"rounded-md border p-3 text-left text-sm hover:bg-token-main-surface-secondary "+(!browserSessionDraft.useCopy?"border-token-border-strong bg-token-main-surface-secondary":"border-token-border-default"),
                "aria-pressed":!browserSessionDraft.useCopy,
                onClick:function(){updateBrowserSessionDraft(function(next){next.useCopy=false;});}
              },
                h("div",{className:"font-medium text-token-text-primary"},"Use folder directly"),
                h("div",{className:"mt-1 text-xs text-token-text-secondary"},"Runs Chrome directly on the selected folder. Close the host browser first: a profile a desktop browser holds is refused.")
              )
            ),
            h("div",{className:"flex flex-wrap justify-end gap-2"},
              button("Cancel",false,function(){setBrowserSessionDraft(null);}),
              button(browserSessionDraft.useCopy?"Create from copy":"Create direct",versionBlocked||!browserSessionDraft.profileId?.trim()||activeAction==="profileTemplate",finishBrowserSessionProfile)
            )
          )
          )
        : null,

      editingProfile
        ? h("div",{className:"fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4",role:"presentation"},
          h("section",{className:"mx-auto flex max-h-[calc(100vh-2rem)] max-w-4xl flex-col gap-3 overflow-y-auto rounded-md border border-token-border-default bg-token-bg-primary p-3 shadow-xl",role:"dialog","aria-modal":true},
            h("div",{className:"flex items-center justify-between"},
              h("div",{className:"text-sm font-medium text-token-text-primary"},editingSaved?"Edit saved":"Create new"),
              profileFormLocked?statusPill("Active - locked","warn"):statusPill(editingSaved?selectedProfileId:"New","idle")
            ),
            profileFormLocked
              ? h("div",{className:"rounded-md border border-yellow-500/30 bg-token-main-surface-secondary p-2 text-sm text-token-text-secondary"},"Stop the active workspace before changing this saved profile.")
              : null,
            h("div",{className:"grid gap-3 md:grid-cols-3"},
              field("Workspace name",profile?.id||"",function(value){setProfileTextField("id",value);},"desktop-qa",profileFormLocked),
              field("Description",profile?.description||"",function(value){setProfileTextField("description",value);},"Desktop QA",profileFormLocked),
              field("Working folder",profile?.cwd||"",function(value){setProfileTextField("cwd",value);},"/path/to/project",profileFormLocked)
            ),
            h("div",{className:"flex flex-col gap-2 rounded-md border border-token-border-default p-3"},
              h("div",{className:"flex items-center justify-between gap-2"},
                h("div",{className:"text-sm font-medium text-token-text-primary"},"Startup apps"),
                button("Pick app",!profile||profileFormLocked,pickStartupApp)
              ),
              startupApps.length===0
                ? h("div",{className:"text-sm text-token-text-tertiary"},"No startup apps")
                : h("div",{className:"flex flex-col gap-2"},
                    startupApps.map(function(app,index){
                      return h("div",{key:String(index),className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2 text-sm"},
                        h("div",{className:"min-w-0"},
                          h("div",{className:"truncate text-token-text-primary"},app.name||commandText(app.command)),
                          h("div",{className:"truncate text-token-text-tertiary"},commandText(app.command))
                        ),
                        button("Remove",profileFormLocked,function(){removeStartupApp(index);})
                      );
                    })
                  ),
              h("div",{className:"grid gap-2 md:grid-cols-[1fr_auto]"},
                field("Manual app command",manualApp,setManualApp,"firefox --new-window",profileFormLocked),
                h("div",{className:"flex items-end"},button("Add manually",!manualApp.trim()||profileFormLocked,addManualStartupApp))
              )
            ),
            editingSaved?field("Workspace purpose",purpose,setPurpose,"QA run",profileFormLocked):null,
            h("details",{
              className:"rounded-md border border-token-border-default bg-token-main-surface-secondary text-sm",
              open:advancedOpen,
              onToggle:function(event){setAdvancedOpen(event.currentTarget.open);}
            },
              h("summary",{className:"cursor-pointer px-3 py-2 text-token-text-primary"},"Advanced settings"),
              advancedOpen?h("textarea",{
                className:"min-h-[220px] w-full border-t border-token-border-default bg-token-bg-primary p-3 font-mono text-xs text-token-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-60",
                value:profileJson,
                onChange:function(event){setProfileJson(event.target.value);},
                spellCheck:false,
                disabled:profileFormLocked
              }):null
            ),
            h("div",{className:"flex flex-wrap justify-between gap-2"},
              h("div",{className:"flex flex-wrap gap-2"},
                button("Validate",!profile||profileFormLocked,function(){callAgentWorkspace("profileValidate",{profile:profile});}),
                editingSaved?button("Save changes",versionBlocked||!profile||profileFormLocked,function(){saveProfile(true);}):button("Create",versionBlocked||!profile||profileFormLocked,function(){saveProfile(false);}),
                button("Cancel",false,function(){setEditingProfile(false);})
              ),
              editingSaved
                ? h("div",{className:"flex flex-wrap gap-2"},
                    button("Preview start",!profile||profileFormLocked,previewStart),
                    button("Start",startDisabled||profileFormLocked,startWorkspace)
                  )
                : null
            )
          )
          )
        : null,

      resultView(result,resultOpen,setResultOpen)
    )
  );
}

export{createAgentWorkspacesSettings};
`;
}

function webviewAssetsDir(extractedDir) {
  return path.join(extractedDir, "webview", "assets");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IDENT = "[A-Za-z_$][\\w$]*";
const REF = `${IDENT}(?:\\.${IDENT})*`;

// The official webview is an rspack build: every chunk declares
// `__webpack_modules__={id(module,exports,require){...},...}`. Modules are
// duplicated into several lazily loaded chunks and minified separately, so a
// settings contract is resolved and patched inside each module copy.
function rspackModules(source) {
  const start = source.indexOf("__webpack_modules__={");
  if (start < 0) return [];
  const header = new RegExp(`^,?("[^"]+"|${IDENT}|\\d+)\\(((?:${IDENT}(?:,${IDENT}){0,2})?)\\)\\{`, "u");
  const modules = [];
  let index = start + "__webpack_modules__={".length;
  while (index < source.length) {
    const match = header.exec(source.slice(index, index + 200));
    if (match == null) break;
    const open = index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) break;
    const id = match[1].startsWith("\"") ? JSON.parse(match[1]) : match[1];
    modules.push({ id, params: match[2].split(","), start: open, end: close + 1 });
    index = close + 1;
  }
  return modules;
}

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function replaceOnce(source, needle, replacement, description) {
  if (source.split(needle).length !== 2) {
    throw new Error(`could not uniquely resolve current ${description}`);
  }
  return source.replace(needle, () => replacement);
}

const SETTINGS_TITLE = "Agent Workspaces";
const SETTINGS_DESCRIPTION = "Title for Agent Workspaces settings section";

// Each contract owns one upstream settings concern. `needle` preselects
// chunks (pristine or patched) before module parsing, `select` recognises a
// pristine or patched module copy, `patched` tells them apart and `apply`
// returns the patched module text or throws when the copy has drifted.
const SETTINGS_CONTRACTS = [
  {
    name: "navigationLabel",
    copies: "all",
    needle: '"local-environments":{id:"settings.nav.local-environments"',
    select: (body) => body.includes('"local-environments":{id:"settings.nav.local-environments",'),
    patched: (body) => body.includes(`"${SETTINGS_SLUG}":{id:"settings.nav.${SETTINGS_SLUG}"`),
    apply(body) {
      const label = uniqueMatch(body, /"local-environments":\{id:"settings\.nav\.local-environments",defaultMessage:"[^"]*",description:"[^"]*"\},/g);
      if (label == null) throw new Error("could not uniquely resolve current settings navigation label");
      return body.replace(label[0], () =>
        `${label[0]}"${SETTINGS_SLUG}":{id:"settings.nav.${SETTINGS_SLUG}",defaultMessage:${JSON.stringify(SETTINGS_TITLE)},description:${JSON.stringify(SETTINGS_DESCRIPTION)}},`);
    },
  },
  {
    name: "sectionTitle",
    copies: "all",
    needle: '"settings.section.local-environments"',
    select: (body) => body.includes('case"local-environments":{') && body.includes('id:"settings.section.local-environments"'),
    patched: (body) => body.includes(`id:"settings.section.${SETTINGS_SLUG}"`),
    apply(body) {
      const renderer = uniqueMatch(body, new RegExp(
        `case"local-environments":\\{[^{}]*?\\(0,(${IDENT})\\.jsx\\)\\((${REF}),\\{id:"settings\\.section\\.local-environments"`,
        "g",
      ));
      if (renderer == null) throw new Error("could not resolve current settings section renderer aliases");
      const [, jsx, message] = renderer;
      return replaceOnce(
        body,
        'case"worktrees":{',
        `case"${SETTINGS_SLUG}":return(0,${jsx}.jsx)(${message},{id:"settings.section.${SETTINGS_SLUG}",defaultMessage:${JSON.stringify(SETTINGS_TITLE)},description:${JSON.stringify(SETTINGS_DESCRIPTION)}});case"worktrees":{`,
        "settings section titles",
      );
    },
  },
  {
    name: "route",
    copies: "one",
    needle: ".GeneralSettings)",
    select: (body) => body.includes('"general-settings":') && body.includes(".GeneralSettings)") && /,notifications:\(0,/.test(body),
    patched: (body) => body.includes(`"${SETTINGS_SLUG}":`),
    apply(body, context) {
      const route = uniqueMatch(body, new RegExp(
        `"general-settings":(${IDENT}),notifications:(\\(0,${IDENT}\\.${IDENT}\\)|${IDENT})\\(async\\(\\)=>`,
        "g",
      ));
      if (route == null) throw new Error("could not add agent workspace settings route");
      const [, general, lazy] = route;
      if (!new RegExp(`(?<![\\w$.])${escapeRegExp(general)}=${escapeRegExp(lazy)}\\(async\\(\\)=>[^;]*?\\.GeneralSettings\\)`).test(body)) {
        throw new Error("could not resolve current settings route loader");
      }
      const { require, importPath, reactModuleId, request } = context.route;
      const loader =
        `"${SETTINGS_SLUG}":${lazy}(async()=>{let[{createAgentWorkspacesSettings:codexLinuxCreate}]=await Promise.all([` +
        `import(${JSON.stringify(importPath)}),${require}.e(${request.chunkId})]);` +
        `return codexLinuxCreate({React:${require}(${JSON.stringify(reactModuleId)}),post:${require}(${JSON.stringify(request.moduleId)}).${request.exportName}})}),`;
      return body.slice(0, route.index) + loader + body.slice(route.index);
    },
  },
  {
    name: "navigation",
    copies: "one",
    needle: '"git-settings","local-environments","',
    select: (body) => ['"git-settings","local-environments","worktrees","browser-use"',
      `"git-settings","local-environments","${SETTINGS_SLUG}","worktrees","browser-use"`].some((needle) => body.includes(needle)),
    patched: (body) => body.includes(`"local-environments","${SETTINGS_SLUG}","worktrees","browser-use"`) ||
      body.includes(`"local-environments","${SETTINGS_SLUG}","environments","worktrees"]`),
    apply(body) {
      let patched = replaceOnce(body, '"git-settings","local-environments","worktrees","browser-use"',
        `"git-settings","local-environments","${SETTINGS_SLUG}","worktrees","browser-use"`, "settings navigation order");
      patched = replaceOnce(patched, '"local-environments","environments","worktrees"]',
        `"local-environments","${SETTINGS_SLUG}","environments","worktrees"]`, "settings navigation group");
      return patched;
    },
    complete: (body) => body.includes(`"local-environments","${SETTINGS_SLUG}","worktrees","browser-use"`) &&
      body.includes(`"local-environments","${SETTINGS_SLUG}","environments","worktrees"]`),
  },
  {
    name: "visibility",
    copies: "one",
    needle: 'case"worktrees":case"local-environments":',
    select: (body) => body.includes('case"worktrees":case"local-environments":'),
    patched: (body) => body.includes(`case"local-environments":case"${SETTINGS_SLUG}":`) ||
      body.includes(`"local-environments","${SETTINGS_SLUG}","worktrees","storage"`) ||
      body.includes(`,"${SETTINGS_SLUG}":`),
    apply(body) {
      let patched = replaceOnce(body, 'case"worktrees":case"local-environments":case"environments":',
        `case"worktrees":case"local-environments":case"${SETTINGS_SLUG}":case"environments":`, "settings visibility cases");
      patched = replaceOnce(patched, '"hooks-settings","gateways","local-environments","worktrees","storage"',
        `"hooks-settings","gateways","local-environments","${SETTINGS_SLUG}","worktrees","storage"`, "settings preload allowlist");
      const policy = uniqueMatch(patched, /"local-environments":("[A-Za-z]+"|[A-Za-z_$][\w$]*),"mcp-settings":/g);
      if (policy == null) throw new Error("could not uniquely resolve current settings host policy");
      return patched.replace(policy[0], () => `"local-environments":${policy[1]},"${SETTINGS_SLUG}":${policy[1]},"mcp-settings":`);
    },
    complete: (body) => body.includes(`case"local-environments":case"${SETTINGS_SLUG}":`) &&
      body.includes(`"local-environments","${SETTINGS_SLUG}","worktrees","storage"`) &&
      new RegExp(`"local-environments":("[A-Za-z]+"|${IDENT}),"${SETTINGS_SLUG}":\\1,"mcp-settings":`).test(body),
  },
  {
    name: "icon",
    copies: "one",
    needle: '"local-environments":{component:',
    select: (body) => body.includes('"local-environments":{component:'),
    patched: (body) => body.includes(`"${SETTINGS_SLUG}":{component:`),
    apply(body) {
      const icon = uniqueMatch(body, new RegExp(
        `"local-environments":(\\{component:${REF},commandAsset:${REF},navigation:\\{assets:\\{16:${REF},20:${REF}\\},ariaHidden:!1\\}\\}),worktrees:`,
        "g",
      ));
      if (icon == null) throw new Error("could not uniquely resolve current settings icon descriptor");
      return body.replace(icon[0], () => `"local-environments":${icon[1]},"${SETTINGS_SLUG}":${icon[1]},worktrees:`);
    },
  },
  {
    name: "catalogSlugs",
    copies: "all",
    needle: '"computer-use","local-environments","',
    select: (body) => body.includes('"local-environments","worktrees","environments"') ||
      body.includes(`"local-environments","${SETTINGS_SLUG}","worktrees","environments"`),
    patched: (body) => body.includes(`"local-environments","${SETTINGS_SLUG}","worktrees","environments"`),
    apply: (body) => replaceOnce(body, '"local-environments","worktrees","environments"',
      `"local-environments","${SETTINGS_SLUG}","worktrees","environments"`, "settings slug catalog"),
  },
  {
    name: "catalogItems",
    copies: "one",
    needle: '{slug:"local-environments"},{slug:"',
    select: (body) => body.includes('{slug:"local-environments"},{slug:"worktrees"}') ||
      body.includes(`{slug:"local-environments"},{slug:"${SETTINGS_SLUG}"},{slug:"worktrees"}`),
    patched: (body) => body.includes(`{slug:"local-environments"},{slug:"${SETTINGS_SLUG}"},{slug:"worktrees"}`),
    apply: (body) => replaceOnce(body, '{slug:"local-environments"},{slug:"worktrees"}',
      `{slug:"local-environments"},{slug:"${SETTINGS_SLUG}"},{slug:"worktrees"}`, "settings section catalog"),
  },
];

// React is vendored once in an entry chunk; resolve its module id by the
// package's own exports instead of a minified module key.
function isReactModule(body) {
  return body.includes('Symbol.for("react.transitional.element")') &&
    /\.useState=function\(/.test(body) && /\.createElement=function\(/.test(body) && /\.useId=function\(/.test(body);
}

function relativeImportPath(fromAsset, toAsset) {
  const relative = path.posix.relative(path.posix.dirname(fromAsset), toAsset);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function collectAgentWorkspaceSettingsPatches(extractedDir) {
  const assetsDir = webviewAssetsDir(extractedDir);
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`missing webview assets directory ${assetsDir}`);
  }
  const request = findCodexRequestWebviewAsset(assetsDir);
  const needles = [...SETTINGS_CONTRACTS.map(({ needle }) => needle), 'Symbol.for("react.transitional.element")'];
  const assets = [];
  for (const assetName of listWebviewScriptAssets(extractedDir)) {
    if (assetName === SETTINGS_ASSET) continue;
    const source = fs.readFileSync(path.join(assetsDir, assetName), "utf8");
    if (needles.some((needle) => source.includes(needle))) {
      assets.push({ assetName, source, modules: rspackModules(source) });
    }
  }

  const reactModules = new Set();
  for (const asset of assets) {
    for (const module of asset.modules) {
      if (isReactModule(asset.source.slice(module.start, module.end))) reactModules.add(module.id);
    }
  }
  if (reactModules.size !== 1) {
    throw new Error(`could not uniquely resolve the React module (${reactModules.size})`);
  }
  const [reactModuleId] = reactModules;

  const edits = new Map();
  for (const contract of SETTINGS_CONTRACTS) {
    const owners = [];
    for (const asset of assets) {
      for (const module of asset.modules) {
        const body = asset.source.slice(module.start, module.end);
        if (contract.select(body)) owners.push({ asset, module, body });
      }
    }
    if (owners.length === 0 || (contract.copies === "one" && owners.length !== 1)) {
      throw new Error(`could not uniquely resolve webview settings semantic owners (${contract.name}=${owners.length})`);
    }
    for (const { asset, module, body } of owners) {
      const existing = edits.get(asset.assetName)?.get(module.start)?.text ?? body;
      if (contract.patched(existing)) {
        if (contract.complete != null && !contract.complete(existing)) {
          throw new Error(`agent workspace settings ${contract.name} is partially patched`);
        }
        continue;
      }
      const requireParam = module.params[2];
      const context = {
        route: {
          require: requireParam,
          importPath: relativeImportPath(asset.assetName, SETTINGS_ASSET),
          reactModuleId,
          request,
        },
      };
      if (contract.name === "route" && requireParam == null) {
        throw new Error("could not resolve current settings route require binding");
      }
      const text = contract.apply(existing, context);
      if (!edits.has(asset.assetName)) edits.set(asset.assetName, new Map());
      edits.get(asset.assetName).set(module.start, { module, text });
    }
  }

  const patches = [];
  for (const asset of assets) {
    const assetEdits = edits.get(asset.assetName);
    if (assetEdits == null) continue;
    let patchedSource = asset.source;
    for (const { module, text } of [...assetEdits.values()].sort((a, b) => b.module.start - a.module.start)) {
      patchedSource = patchedSource.slice(0, module.start) + text + patchedSource.slice(module.end);
    }
    patches.push({ filePath: path.join(assetsDir, asset.assetName), currentSource: asset.source, patchedSource });
  }
  return { patches, request };
}

function patchAgentWorkspaceSettingsAssets(extractedDir) {
  try {
    const { patches } = collectAgentWorkspaceSettingsPatches(extractedDir);
    const settingsPath = path.join(webviewAssetsDir(extractedDir), SETTINGS_ASSET);
    const settingsSource = buildAgentWorkspaceSettingsSource();
    const previousSettingsSource = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : null;

    fs.writeFileSync(settingsPath, settingsSource, "utf8");
    let changed = previousSettingsSource !== settingsSource ? 1 : 0;
    for (const patch of patches) {
      fs.writeFileSync(patch.filePath, patch.patchedSource, "utf8");
      changed += 1;
    }
    return { matched: true, changed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: Agent Workspaces settings patch skipped: ${message}`);
    return { matched: false, changed: 0, reason: message };
  }
}

module.exports = {
  descriptors: [
    {
      id: "main-bridge",
      phase: "main-bundle",
      order: 20_800,
      ciPolicy: "optional",
      apply: applyAgentWorkspaceMainBridgePatch,
    },
    {
      id: "settings-page",
      phase: "extracted-app:post-webview",
      order: 20_810,
      ciPolicy: "optional",
      apply: (extractedDir) => patchAgentWorkspaceSettingsAssets(extractedDir),
      status: (result, warnings) => {
        if (result?.matched === false) {
          return { status: "skipped-optional", reason: result.reason ?? warnings[0] ?? null };
        }
        if ((result?.changed ?? 0) > 0) {
          return "applied";
        }
        return "already-applied";
      },
    },
  ],
  SETTINGS_ASSET,
  SETTINGS_COMMAND_KEY,
  SETTINGS_PERMISSIONS_KEY,
  SETTINGS_SLUG,
  SETTINGS_CONTRACTS,
  GLOBAL_STATE_GET_METHOD,
  GLOBAL_STATE_SET_METHOD,
  applyAgentWorkspaceMainBridgePatch,
  buildAgentWorkspaceSettingsSource,
  collectAgentWorkspaceSettingsPatches,
  patchAgentWorkspaceSettingsAssets,
};
