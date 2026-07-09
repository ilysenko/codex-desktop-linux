"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  findCodexRequestWebviewAsset,
  findImportedAsset,
  findRequiredWebviewAsset,
} = require("../../scripts/patches/lib/assets.js");
const {
  requireName,
} = require("../../scripts/patches/lib/minified-js.js");

const SETTINGS_ASSET = "agent-workspaces-linux.js";
const SETTINGS_SLUG = "agent-workspaces";
const SETTINGS_COMMAND_KEY = "codex-linux-agent-workspace-command";
const SETTINGS_PERMISSIONS_KEY = "codex-linux-agent-workspace-permissions";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function agentWorkspaceAppPickerBridgeSource({ fsVar, pathVar }) {
  return [
    `"linux-agent-workspace-pick-app":async()=>{let __codexElectron;try{__codexElectron=require("electron")}catch(e){return{ok:!1,action:"pickStartupApp",message:"file picker unavailable"}}`,
    `let __codexDesktopTokens=e=>{let t=[],n="",r=null,a=!1,o=String(e||"");for(let i=0;i<o.length;i++){let c=o[i];if(a){n+=c,a=!1;continue}if(c==="\\\\"){a=!0;continue}if(r){if(c===r)r=null;else n+=c;continue}if(c==="'"||c==='"'){r=c;continue}if(/\\s/.test(c)){if(n)t.push(n),n="";continue}n+=c}if(a)n+="\\\\";if(n)t.push(n);return t};`,
    `let __codexDesktopEntry=__codexPath=>{if(typeof __codexPath!=="string"||!__codexPath.endsWith(".desktop"))return null;try{let __codexText=${fsVar}.readFileSync(__codexPath,"utf8"),__codexInEntry=!1,__codexName=null,__codexExec=null;for(let __codexLine of __codexText.split(/\\r?\\n/)){let __codexTrimmed=__codexLine.trim();if(!__codexTrimmed||__codexTrimmed.startsWith("#"))continue;if(__codexTrimmed.startsWith("[")&&__codexTrimmed.endsWith("]")){__codexInEntry=__codexTrimmed==="[Desktop Entry]";continue}if(!__codexInEntry)continue;let __codexEquals=__codexTrimmed.indexOf("=");if(__codexEquals<1)continue;let __codexKey=__codexTrimmed.slice(0,__codexEquals),__codexValue=__codexTrimmed.slice(__codexEquals+1).trim();if((__codexKey==="Name"||__codexKey.startsWith("Name["))&&!__codexName)__codexName=__codexValue;else if(__codexKey==="Exec"&&!__codexExec)__codexExec=__codexValue}if(!__codexExec)return null;let __codexPercent="__CODEX_PERCENT__",__codexCleanExec=__codexExec.replace(/%%/g,__codexPercent).replace(/%[A-Za-z]/g,"").replace(new RegExp(__codexPercent,"g"),"%").trim(),__codexCommand=__codexDesktopTokens(__codexCleanExec);return __codexCommand.length?{name:__codexName||${pathVar}.basename(__codexPath,".desktop"),command:__codexCommand,desktop_file:__codexPath}:null}catch{return null}};`,
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
const AGENT_WORKSPACE_BRIDGE_SOURCE_TEMPLATE = "\"linux-agent-workspace-pick-app\":async()=>{let __codexElectron;try{__codexElectron=require(\"electron\")}catch(e){return{ok:!1,action:\"pickStartupApp\",message:\"file picker unavailable\"}}let __codexDesktopTokens=e=>{let t=[],n=\"\",r=null,a=!1,o=String(e||\"\");for(let i=0;i<o.length;i++){let c=o[i];if(a){n+=c,a=!1;continue}if(c===\"\\\\\"){a=!0;continue}if(r){if(c===r)r=null;else n+=c;continue}if(c===\"'\"||c==='\"'){r=c;continue}if(/\\s/.test(c)){if(n)t.push(n),n=\"\";continue}n+=c}if(a)n+=\"\\\\\";if(n)t.push(n);return t};let __codexDesktopEntry=__codexPath=>{if(typeof __codexPath!==\"string\"||!__codexPath.endsWith(\".desktop\"))return null;try{let __codexText=__CODEX_FS_VAR__.readFileSync(__codexPath,\"utf8\"),__codexInEntry=!1,__codexName=null,__codexExec=null;for(let __codexLine of __codexText.split(/\\r?\\n/)){let __codexTrimmed=__codexLine.trim();if(!__codexTrimmed||__codexTrimmed.startsWith(\"#\"))continue;if(__codexTrimmed.startsWith(\"[\")&&__codexTrimmed.endsWith(\"]\")){__codexInEntry=__codexTrimmed===\"[Desktop Entry]\";continue}if(!__codexInEntry)continue;let __codexEquals=__codexTrimmed.indexOf(\"=\");if(__codexEquals<1)continue;let __codexKey=__codexTrimmed.slice(0,__codexEquals),__codexValue=__codexTrimmed.slice(__codexEquals+1).trim();if((__codexKey===\"Name\"||__codexKey.startsWith(\"Name[\"))&&!__codexName)__codexName=__codexValue;else if(__codexKey===\"Exec\"&&!__codexExec)__codexExec=__codexValue}if(!__codexExec)return null;let __codexPercent=\"__CODEX_PERCENT__\",__codexCleanExec=__codexExec.replace(/%%/g,__codexPercent).replace(/%[A-Za-z]/g,\"\").replace(new RegExp(__codexPercent,\"g\"),\"%\").trim(),__codexCommand=__codexDesktopTokens(__codexCleanExec);return __codexCommand.length?{name:__codexName||__CODEX_PATH_VAR__.basename(__codexPath,\".desktop\"),command:__codexCommand,desktop_file:__codexPath}:null}catch{return null}};try{let e=await __codexElectron.dialog.showOpenDialog({title:\"Choose startup app\",properties:[\"openFile\"]});let t=Array.isArray(e.filePaths)?e.filePaths:[],n=t[0]||null,r=__codexDesktopEntry(n);return{ok:!e.canceled&&t.length>0,action:\"pickStartupApp\",json:{canceled:!!e.canceled,path:n,paths:t,startup_app:r,desktop:!!r}}}catch(e){return{ok:!1,action:\"pickStartupApp\",message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace-pick-mount\":async()=>{let __codexElectron;try{__codexElectron=require(`electron`)}catch(e){return{ok:!1,action:`pickMount`,message:`file picker unavailable`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:`Choose file or folder to mount`,properties:[`openFile`,`openDirectory`,`multiSelections`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:`pickMount`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:`pickMount`,message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace-pick-browser-data\":async()=>{let __codexElectron;try{__codexElectron=require(`electron`)}catch(e){return{ok:!1,action:`pickBrowserData`,message:`file picker unavailable`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:`Choose browser data folder`,properties:[`openDirectory`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:`pickBrowserData`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:`pickBrowserData`,message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace-copy-browser-data\":async({sourcePath:__codexSourcePath,profileId:__codexProfileId}={})=>{let __codexString=e=>typeof e===`string`&&e.trim().length>0?e.trim():null,__codexHome=()=>typeof process.env.HOME===`string`&&process.env.HOME.trim().length>0?process.env.HOME.trim():null,__codexExpand=e=>{let t=__codexString(e),n=__codexHome();return t&&t.startsWith(`~/`)&&n?__CODEX_PATH_VAR__.join(n,t.slice(2)):t},__codexSafe=e=>String(e||`browser-session`).toLowerCase().replace(/[^a-z0-9._-]+/g,`-`).replace(/^-+|-+$/g,``)||`browser-session`;try{let e=__codexExpand(__codexSourcePath);if(!e)return{ok:!1,action:`copyBrowserData`,message:`browser data folder is required`};if(!__CODEX_FS_VAR__.existsSync(e)||!__CODEX_FS_VAR__.statSync(e).isDirectory())return{ok:!1,action:`copyBrowserData`,message:`browser data folder does not exist`,json:{source_path:e}};let t=__codexSafe(__codexProfileId),n=__codexExpand(process.env.XDG_DATA_HOME)||(__codexHome()?__CODEX_PATH_VAR__.join(__codexHome(),`.local`,`share`):__CODEX_PATH_VAR__.join(process.env.TMPDIR||`/tmp`,`codex-agent-workspace-data`)),r=__CODEX_PATH_VAR__.join(n,`agent-workspace-linux`,`browser-sessions`,t);if(__CODEX_FS_VAR__.existsSync(r))return{ok:!1,action:`copyBrowserData`,message:`managed browser-session copy already exists`,json:{source_path:e,path:r,profile_id:t}};__CODEX_FS_VAR__.mkdirSync(__CODEX_PATH_VAR__.dirname(r),{recursive:!0,mode:448});let a=new Set([`SingletonCookie`,`SingletonLock`,`SingletonSocket`,`lockfile`,`.parentlock`]);await __CODEX_FS_VAR__.promises.cp(e,r,{recursive:!0,force:!1,errorOnExist:!0,filter:(e)=>{let t=__CODEX_PATH_VAR__.basename(e);return !a.has(t)&&!t.startsWith(`Singleton`)}});return{ok:!0,action:`copyBrowserData`,json:{source_path:e,path:r,profile_id:t,copied:!0,excluded_lock_files:!0}}}catch(e){return{ok:!1,action:`copyBrowserData`,message:e instanceof Error?e.message:String(e)}}},\"linux-agent-workspace\":async({action:__codexAction,timeoutMs:__codexTimeoutMs,profileId:__codexProfileId,profile:__codexProfile,replace:__codexReplace,dryRun:__codexDryRun,workspaceId:__codexWorkspaceId,purpose:__codexPurpose,runSetup:__codexRunSetup,ackHiddenWorkspace:__codexAckHiddenWorkspace,ackUnenforcedPolicy:__codexAckUnenforcedPolicy,startupWaitWindow:__codexStartupWaitWindow,startupScreenshotWindow:__codexStartupScreenshotWindow,cleanupId:__codexCleanupId,outputPath:__codexOutputPath,templateKind:__codexTemplateKind,hostPath:__codexHostPath,browserPath:__codexBrowserPath,userDataDir:__codexUserDataDir,alwaysOnTop:__codexAlwaysOnTop,permissions:__codexPermissions}={})=>{let __codexHome=()=>typeof process.env.HOME===`string`&&process.env.HOME.trim().length>0?process.env.HOME.trim():null,__codexExpandCommand=e=>{if(typeof e!==`string`)return e;let t=e.trim(),n=__codexHome();return t.startsWith(`~/`)&&n?__CODEX_PATH_VAR__.join(n,t.slice(2)):t},__codexBinExists=p=>{try{return typeof p===`string`&&p.length>0&&__CODEX_FS_VAR__.existsSync(p)&&__CODEX_FS_VAR__.statSync(p).isFile()}catch{return!1}},__codexAddCandidate=(e,t)=>{t&&e.indexOf(t)===-1&&e.push(t)},__codexFromPathCandidates=e=>{let t=[];if(typeof process.env.PATH!==`string`||process.env.PATH.length===0)return t;for(let n of process.env.PATH.split(__CODEX_PATH_VAR__.delimiter)){if(!n)continue;__codexAddCandidate(t,__CODEX_PATH_VAR__.join(n,e))}return t},__codexFirstExisting=e=>{for(let t of e){if(__codexBinExists(t))return t}return null},__codexDefaultCandidates=()=>{let e=[],t=__codexHome(),n=(typeof process.env.CARGO_HOME===`string`&&process.env.CARGO_HOME.trim().length>0?process.env.CARGO_HOME.trim():null);n=__codexExpandCommand(n||(t?__CODEX_PATH_VAR__.join(t,`.cargo`):null)),__codexAddCandidate(e,n?__CODEX_PATH_VAR__.join(n,`bin`,`agent-workspace-linux`):null);let r=(typeof process.env.NPM_CONFIG_PREFIX===`string`&&process.env.NPM_CONFIG_PREFIX.trim().length>0?process.env.NPM_CONFIG_PREFIX.trim():null);r&&__codexAddCandidate(e,__CODEX_PATH_VAR__.join(__codexExpandCommand(r),`bin`,`agent-workspace-linux`));if(t){__codexAddCandidate(e,__CODEX_PATH_VAR__.join(t,`.npm-global`,`bin`,`agent-workspace-linux`));__codexAddCandidate(e,__CODEX_PATH_VAR__.join(t,`.local`,`share`,`npm`,`bin`,`agent-workspace-linux`))}__codexAddCandidate(e,`/usr/local/bin/agent-workspace-linux`);__codexAddCandidate(e,`/usr/local/lib/node_modules/@agent-sh/agent-workspace-linux/bin/agent-workspace-linux.js`);__codexAddCandidate(e,`/usr/local/lib/node_modules/@agent-sh/agent-workspace-linux/bin/agent-workspace-linux`);for(let t of __codexFromPathCandidates(`agent-workspace-linux`))__codexAddCandidate(e,t);t&&__codexAddCandidate(e,__CODEX_PATH_VAR__.join(t,`.local`,`bin`,`agent-workspace-linux`));return e},__codexFromPath=()=>__codexFirstExisting(__codexFromPathCandidates(`agent-workspace-linux`)),__codexDefaultCommand=()=>{let e=process.env.CODEX_AGENT_WORKSPACE_BIN;if(typeof e===`string`&&e.trim().length>0)return __codexExpandCommand(e);return __codexFirstExisting(__codexDefaultCandidates())||`agent-workspace-linux`},__codexCommand=this.globalState.get(`codex-linux-agent-workspace-command`)||__codexDefaultCommand();if(typeof __codexCommand!==`string`||__codexCommand.trim().length===0)__codexCommand=__codexDefaultCommand();__codexCommand=__codexExpandCommand(__codexCommand);let __codexArgs=[],__codexTempPath=null,__codexString=e=>typeof e===`string`&&e.trim().length>0?e.trim():null,__codexDataHome=()=>{let e=__codexString(process.env.XDG_DATA_HOME);return e?__codexExpandCommand(e):(__codexHome()?__CODEX_PATH_VAR__.join(__codexHome(),`.local`,`share`):__CODEX_PATH_VAR__.join(process.env.TMPDIR||`/tmp`,`codex-agent-workspace-data`))},__codexPermissionPath=__codexString(this.globalState.get(`codex-linux-agent-workspace-permissions`));__codexPermissionPath&&(__codexPermissionPath=__codexExpandCommand(__codexPermissionPath));let __codexReadPermissionConfig=e=>{if(!e)return{configured:!1,restricted:!1,permissions_path:null,message:`No workspace permission file configured`};let t=null,n=null;try{__CODEX_FS_VAR__.existsSync(e)?t=JSON.parse(__CODEX_FS_VAR__.readFileSync(e,`utf8`)):n=`permission file does not exist`}catch(e){n=e instanceof Error?e.message:String(e)}let r=!!(t&&((t.network&&t.network.mode&&t.network.mode!==`inherit_host`)||(Array.isArray(t.mounts)&&t.mounts.length>0)||(Array.isArray(t.apps?.allow)&&t.apps.allow.length>0)));return{configured:!0,restricted:n?!0:r,permissions_path:e,ceiling:t,error:n,message:n?`Permission file could not be loaded`:r?`Permission file is active`:`Permission file is configured but open; Codex session permissions apply`}},__codexPermissionConfig=__codexReadPermissionConfig(__codexPermissionPath),__codexPushId=(e,t)=>{let n=__codexString(t);if(n)__codexArgs.push(e,n)},__codexActionName=__codexString(__codexAction);try{switch(__codexActionName){case`installRuntime`:{let e=`npm`,t=__codexFirstExisting(__codexFromPathCandidates(e))||e,n=[`install`,`-g`,`@agent-sh/agent-workspace-linux`],r=Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):3e5;return await new Promise(o=>{__CODEX_CHILD_PROCESS_VAR__.execFile(t,n,{encoding:`utf8`,timeout:r,maxBuffer:16777216},(r,a,i)=>{r?o({ok:!1,action:__codexActionName,manager:e,command:t,args:n,message:r instanceof Error?r.message:String(r),code:r?.code??null,stdout:a||``,stderr:i||``}):o({ok:!0,action:__codexActionName,manager:e,command:t,args:n,stdout:a||``,stderr:i||``,json:{ok:!0,manager:e}})})})}case`permissionConfig`:return{ok:!__codexPermissionConfig.error,action:__codexActionName,json:__codexPermissionConfig,message:__codexPermissionConfig.error||void 0};case`permissionSave`:{let e=__codexPermissions;if(!e||typeof e!==`object`||Array.isArray(e))return{ok:!1,action:__codexActionName,message:`permissions object is required`};let t=JSON.parse(JSON.stringify(e)),n=t.network;if(n!=null){if(typeof n!==`object`||Array.isArray(n))return{ok:!1,action:__codexActionName,message:`permission network must be an object`};let e=__codexString(n.mode)||`inherit_host`;if(![`inherit_host`,`disabled`,`local_only`].includes(e))return{ok:!1,action:__codexActionName,message:`permission network mode must be inherit_host, disabled, or local_only`};n.mode=e,n.allow_hosts=Array.isArray(n.allow_hosts)?n.allow_hosts.map(String).filter(Boolean):[]}t.network=n||{mode:`inherit_host`},Array.isArray(t.mounts)||(t.mounts=[]);for(let e of t.mounts){if(!e||typeof e!==`object`||Array.isArray(e))return{ok:!1,action:__codexActionName,message:`permission mounts must contain objects`};if(typeof e.host_path!==`string`||!e.host_path.startsWith(`/`))return{ok:!1,action:__codexActionName,message:`permission mount host_path must be absolute`};if(typeof e.workspace_path!==`string`||!e.workspace_path.startsWith(`/`))return{ok:!1,action:__codexActionName,message:`permission mount workspace_path must be absolute`};e.mode=e.mode===`read_write`?`read_write`:`read_only`}(!t.apps||typeof t.apps!==`object`||Array.isArray(t.apps))&&(t.apps={}),Array.isArray(t.apps.allow)||(t.apps.allow=[]);for(let e of t.apps.allow){if(typeof e!==`string`||!e.trim())return{ok:!1,action:__codexActionName,message:`permission app allow entries must be non-empty strings`};if(!e.startsWith(`/`)&&e.includes(`/`))return{ok:!1,action:__codexActionName,message:`permission app allow entries must be absolute paths or bare command names`}}let r=__CODEX_PATH_VAR__.join(__codexDataHome(),`agent-workspace-linux`,`permissions`),a=__CODEX_PATH_VAR__.join(r,`codex-agent-workspace-permissions.json`);try{__CODEX_FS_VAR__.mkdirSync(r,{recursive:!0,mode:448}),__CODEX_FS_VAR__.writeFileSync(a,JSON.stringify(t,null,2)+`\\n`,{encoding:`utf8`,mode:384}),this.globalState.set(`codex-linux-agent-workspace-permissions`,a)}catch(e){return{ok:!1,action:__codexActionName,message:e instanceof Error?e.message:String(e)}}__codexPermissionConfig=__codexReadPermissionConfig(a);return{ok:!__codexPermissionConfig.error,action:__codexActionName,json:__codexPermissionConfig,message:__codexPermissionConfig.error||void 0}}case`doctor`:__codexArgs=[`doctor`];break;case`guardrails`:__codexArgs=[`guardrails`];break;case`profilePath`:__codexArgs=[`profile`,`path`];break;case`profileList`:__codexArgs=[`profile`,`list`];break;case`profileGet`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`get`,e];break}case`profileCheck`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`check`,e];break}case`profileDelete`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`delete`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexArgs.push(e);break}case`profileExport`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`profile`,`export`,e],__codexPushId(`--output`,__codexOutputPath),__codexReplace&&__codexArgs.push(`--replace`);break}case`profileTemplate`:{let e=__codexString(__codexTemplateKind)||`project-dev`;__codexArgs=[`profile`,`template`,e],__codexPushId(`--id`,__codexProfileId),__codexPushId(`--host-path`,__codexHostPath),__codexPushId(`--browser-path`,__codexBrowserPath),__codexPushId(`--user-data-dir`,__codexUserDataDir);break}case`profileValidate`:{if(!__codexProfile||typeof __codexProfile!==`object`||Array.isArray(__codexProfile))throw Error(`profile object is required`);let e=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||`/tmp`,t=__CODEX_FS_VAR__.mkdtempSync(__CODEX_PATH_VAR__.join(e,`codex-agent-workspace-`));__codexTempPath=__CODEX_PATH_VAR__.join(t,`profile.json`),__CODEX_FS_VAR__.writeFileSync(__codexTempPath,JSON.stringify(__codexProfile,null,2)+`\\n`,{encoding:`utf8`,mode:384}),__codexArgs=[`profile`,`validate`,`--json`,__codexTempPath];break}case`profileSave`:{if(!__codexProfile||typeof __codexProfile!==`object`||Array.isArray(__codexProfile))throw Error(`profile object is required`);let e=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||`/tmp`,t=__CODEX_FS_VAR__.mkdtempSync(__CODEX_PATH_VAR__.join(e,`codex-agent-workspace-`));__codexTempPath=__CODEX_PATH_VAR__.join(t,`profile.json`),__CODEX_FS_VAR__.writeFileSync(__codexTempPath,JSON.stringify(__codexProfile,null,2)+`\\n`,{encoding:`utf8`,mode:384}),__codexArgs=[`profile`,`put`,`--json`,__codexTempPath],__codexReplace&&__codexArgs.push(`--replace`),__codexDryRun&&__codexArgs.push(`--dry-run`);break}case`workspaceList`:__codexArgs=[`workspace`,`list`];break;case`workspaceStatus`:__codexArgs=[`workspace`,`status`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceManifest`:__codexArgs=[`workspace`,`manifest`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceArtifacts`:__codexArgs=[`workspace`,`artifacts`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceOpenProfile`:{let e=__codexString(__codexProfileId);if(!e)throw Error(`profile id is required`);__codexArgs=[`workspace`,`open-profile`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexAckHiddenWorkspace&&__codexArgs.push(`--ack-hidden-workspace`),__codexAckUnenforcedPolicy&&__codexArgs.push(`--ack-unenforced-policy`),__codexArgs.push(`--profile`,e),__codexPushId(`--id`,__codexWorkspaceId),__codexPushId(`--purpose`,__codexPurpose),__codexRunSetup&&__codexArgs.push(`--setup`),__codexStartupWaitWindow&&__codexArgs.push(`--startup-wait-window`),__codexStartupScreenshotWindow&&__codexArgs.push(`--startup-screenshot-window`);break}case`workspaceOpenViewer`:{let e=__codexString(__codexWorkspaceId);__codexArgs=[`viewer`],e&&__codexArgs.push(`--id`,e,`--exit-when-workspace-gone`),__codexAlwaysOnTop&&__codexArgs.push(`--always-on-top`);break}case`workspaceStart`:{__codexArgs=[`workspace`,`start`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexAckHiddenWorkspace&&__codexArgs.push(`--ack-hidden-workspace`),__codexAckUnenforcedPolicy&&__codexArgs.push(`--ack-unenforced-policy`),__codexPushId(`--profile`,__codexProfileId),__codexPushId(`--id`,__codexWorkspaceId),__codexPushId(`--purpose`,__codexPurpose);break}case`workspaceStop`:__codexArgs=[`workspace`,`stop`],__codexPushId(`--id`,__codexWorkspaceId);break;case`workspaceCleanup`:__codexArgs=[`workspace`,`cleanup`],__codexDryRun&&__codexArgs.push(`--dry-run`),__codexPushId(`--id`,__codexCleanupId);break;default:throw Error(`unsupported agent workspace action`)}}catch(e){return{ok:!1,action:__codexActionName,message:e instanceof Error?e.message:String(e)}}if(__codexPermissionConfig?.error)return{ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:`Workspace permission file could not be loaded: ${__codexPermissionConfig.error}`,json:__codexPermissionConfig};if(__codexPermissionConfig?.permissions_path)__codexArgs=[`--permissions`,__codexPermissionConfig.permissions_path,...__codexArgs];if(__codexActionName===`workspaceOpenViewer`){return await new Promise(e=>{let t=!1,n=null,r=a=>{if(t)return;t=!0,n&&clearTimeout(n),e(a)},m=a=>a instanceof Error?a.message:String(a);try{let a=__CODEX_CHILD_PROCESS_VAR__.spawn(__codexCommand,__codexArgs,{detached:!0,stdio:`ignore`}),p={ok:!0,action:__codexActionName,command:__codexCommand,args:__codexArgs,json:{ok:!0,id:__codexString(__codexWorkspaceId)||`default`,pid:a?.pid??null,always_on_top:!!__codexAlwaysOnTop,exit_when_workspace_gone:!!__codexString(__codexWorkspaceId)}};a?.once?.(`error`,e=>r({ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:m(e)}));a?.once?.(`spawn`,()=>{a?.unref?.();r(p)});n=setTimeout(()=>{a?.unref?.();r(p)},25)}catch(a){r({ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:m(a)})}})}let __codexParse=e=>{let t=String(e||``).trim();if(t.length===0)return null;try{return JSON.parse(t)}catch{return{raw:t}}};try{let e=await new Promise((e,t)=>{let n=__CODEX_CHILD_PROCESS_VAR__.execFile(__codexCommand,__codexArgs,{encoding:`utf8`,timeout:Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):15e3,maxBuffer:8388608},(n,r,i)=>{n?(n.stdout=r,n.stderr=i,t(n)):e({stdout:r,stderr:i})})}),t=__codexParse(e.stdout);return{ok:!0,action:__codexActionName,command:__codexCommand,args:__codexArgs,stdout:e.stdout,stderr:e.stderr,json:t}}catch(e){let t=__codexParse(e?.stdout);return{ok:!1,action:__codexActionName,command:__codexCommand,args:__codexArgs,message:e instanceof Error?e.message:String(e),code:e?.code??null,stdout:e?.stdout??``,stderr:e?.stderr??``,json:t}}finally{if(__codexTempPath)try{__CODEX_FS_VAR__.rmSync(__CODEX_PATH_VAR__.dirname(__codexTempPath),{recursive:!0,force:!0})}catch{}}}";

function agentWorkspaceMountPickerBridgeSource() {
  return `"linux-agent-workspace-pick-mount":async()=>{let __codexElectron;try{__codexElectron=require(\`electron\`)}catch(e){return{ok:!1,action:\`pickMount\`,message:\`file picker unavailable\`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:\`Choose file or folder to mount\`,properties:[\`openFile\`,\`openDirectory\`,\`multiSelections\`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:\`pickMount\`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:\`pickMount\`,message:e instanceof Error?e.message:String(e)}}}`;
}

function agentWorkspaceBrowserDataPickerBridgeSource() {
  return `"linux-agent-workspace-pick-browser-data":async()=>{let __codexElectron;try{__codexElectron=require(\`electron\`)}catch(e){return{ok:!1,action:\`pickBrowserData\`,message:\`file picker unavailable\`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:\`Choose browser data folder\`,properties:[\`openDirectory\`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:\`pickBrowserData\`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:\`pickBrowserData\`,message:e instanceof Error?e.message:String(e)}}}`;
}

function agentWorkspaceBrowserDataCopyBridgeSource({ fsVar, pathVar }) {
  return `"linux-agent-workspace-copy-browser-data":async({sourcePath:__codexSourcePath,profileId:__codexProfileId}={})=>{let __codexString=e=>typeof e===\`string\`&&e.trim().length>0?e.trim():null,__codexHome=()=>typeof process.env.HOME===\`string\`&&process.env.HOME.trim().length>0?process.env.HOME.trim():null,__codexExpand=e=>{let t=__codexString(e),n=__codexHome();return t&&t.startsWith(\`~/\`)&&n?${pathVar}.join(n,t.slice(2)):t},__codexSafe=e=>String(e||\`browser-session\`).toLowerCase().replace(/[^a-z0-9._-]+/g,\`-\`).replace(/^-+|-+$/g,\`\`)||\`browser-session\`;try{let e=__codexExpand(__codexSourcePath);if(!e)return{ok:!1,action:\`copyBrowserData\`,message:\`browser data folder is required\`};if(!${fsVar}.existsSync(e)||!${fsVar}.statSync(e).isDirectory())return{ok:!1,action:\`copyBrowserData\`,message:\`browser data folder does not exist\`,json:{source_path:e}};let t=__codexSafe(__codexProfileId),n=__codexExpand(process.env.XDG_DATA_HOME)||(__codexHome()?${pathVar}.join(__codexHome(),\`.local\`,\`share\`):${pathVar}.join(process.env.TMPDIR||\`/tmp\`,\`codex-agent-workspace-data\`)),r=${pathVar}.join(n,\`agent-workspace-linux\`,\`browser-sessions\`,t);if(${fsVar}.existsSync(r))return{ok:!1,action:\`copyBrowserData\`,message:\`managed browser-session copy already exists\`,json:{source_path:e,path:r,profile_id:t}};${fsVar}.mkdirSync(${pathVar}.dirname(r),{recursive:!0,mode:448});let a=new Set([\`SingletonCookie\`,\`SingletonLock\`,\`SingletonSocket\`,\`lockfile\`,\`.parentlock\`]);await ${fsVar}.promises.cp(e,r,{recursive:!0,force:!1,errorOnExist:!0,filter:(e)=>{let t=${pathVar}.basename(e);return !a.has(t)&&!t.startsWith(\`Singleton\`)}});return{ok:!0,action:\`copyBrowserData\`,json:{source_path:e,path:r,profile_id:t,copied:!0,excluded_lock_files:!0}}}catch(e){return{ok:!1,action:\`copyBrowserData\`,message:e instanceof Error?e.message:String(e)}}}`;
}

function useUserWritableNpmPrefixForInstallRuntime(source) {
  const needle = "case`installRuntime`:{let e=`npm`,t=__codexFirstExisting(__codexFromPathCandidates(e))||e,n=[`install`,`-g`,`@agent-sh/agent-workspace-linux`],r=Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):3e5;";
  const replacement = "case`installRuntime`:{let e=`npm`,t=__codexFirstExisting(__codexFromPathCandidates(e))||e,p=__codexString(process.env.NPM_CONFIG_PREFIX);p=p?__codexExpandCommand(p):(__codexHome()?__CODEX_PATH_VAR__.join(__codexHome(),`.local`):null);let n=[`install`,`-g`],r=Number.isFinite(Number(__codexTimeoutMs))?Number(__codexTimeoutMs):3e5;p&&n.push(`--prefix`,p);n.push(`@agent-sh/agent-workspace-linux`);";
  if (!source.includes(needle)) {
    throw new Error("could not update agent workspace npm install command");
  }
  return source.replace(needle, replacement);
}

function agentWorkspaceBridgeWithWorkspaceStartSource(args) {
  return useUserWritableNpmPrefixForInstallRuntime(AGENT_WORKSPACE_BRIDGE_SOURCE_TEMPLATE)
    .split("__CODEX_CHILD_PROCESS_VAR__").join(args.childProcessVar)
    .split("__CODEX_FS_VAR__").join(args.fsVar)
    .split("__CODEX_PATH_VAR__").join(args.pathVar);
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

function ensureAgentWorkspaceBridgeEntry(currentSource, entrySource) {
  const match = entrySource.match(/^"([^"]+)":/);
  if (!match) {
    return currentSource;
  }
  const marker = `"${match[1]}":async`;
  if (currentSource.includes(marker)) {
    return currentSource;
  }
  return currentSource.replace(`"linux-agent-workspace":async`, `${entrySource},"linux-agent-workspace":async`);
}

function replaceAgentWorkspaceActionBridge(currentSource, actionBridgeSource) {
  const marker = `"linux-agent-workspace":async`;
  const start = currentSource.indexOf(marker);
  if (start === -1) {
    return currentSource;
  }

  const getGlobalStateIndex = currentSource.indexOf(`,"get-global-state":async`, start);
  if (getGlobalStateIndex !== -1) {
    return `${currentSource.slice(0, start)}${actionBridgeSource}${currentSource.slice(getGlobalStateIndex)}`;
  }

  const arrowBodyIndex = currentSource.indexOf("=>{", start);
  if (arrowBodyIndex === -1) {
    return currentSource;
  }
  const bodyStart = arrowBodyIndex + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < currentSource.length; index += 1) {
    const char = currentSource[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return `${currentSource.slice(0, start)}${actionBridgeSource}${currentSource.slice(index + 1)}`;
      }
    }
  }
  return currentSource;
}

function applyAgentWorkspaceMainBridgePatch(currentSource) {
  const patchName = "agent workspace main bridge patch";
  if (currentSource.includes('"linux-agent-workspace":async')) {
    const childProcessVar = requireName(currentSource, "node:child_process");
    const fsVar = requireName(currentSource, "node:fs");
    const pathVar = requireName(currentSource, "node:path");
    if (childProcessVar == null || fsVar == null || pathVar == null) {
      warn("Could not find Node module aliases for agent workspace bridge upgrade", patchName);
      return currentSource;
    }
    const args = { childProcessVar, fsVar, pathVar };
    let patchedSource = currentSource;
    patchedSource = ensureAgentWorkspaceBridgeEntry(patchedSource, agentWorkspaceAppPickerBridgeSource(args));
    patchedSource = ensureAgentWorkspaceBridgeEntry(patchedSource, agentWorkspaceMountPickerBridgeSource());
    patchedSource = ensureAgentWorkspaceBridgeEntry(patchedSource, agentWorkspaceBrowserDataPickerBridgeSource());
    patchedSource = ensureAgentWorkspaceBridgeEntry(patchedSource, agentWorkspaceBrowserDataCopyBridgeSource(args));
    return replaceAgentWorkspaceActionBridge(patchedSource, agentWorkspaceActionBridgeSource(args));
  }

  const childProcessVar = requireName(currentSource, "node:child_process");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (childProcessVar == null || fsVar == null || pathVar == null) {
    warn("Could not find Node module aliases", patchName);
    return currentSource;
  }

  const handlerNeedle = `"get-global-state":async({key:`;
  if (!currentSource.includes(handlerNeedle)) {
    warn("Could not find global-state handler insertion point", patchName);
    return currentSource;
  }

  return currentSource.replace(
    handlerNeedle,
    `${agentWorkspaceBridgeWithWorkspaceStartSource({ childProcessVar, fsVar, pathVar })},${handlerNeedle}`,
  );
}

function buildAgentWorkspaceSettingsSource({
  chunkAsset,
  reactAsset,
  reactExportName = "t",
  codexRequestAsset,
  codexRequestExportName = "n",
  vscodeApiAsset,
}) {
  const requestAsset = codexRequestAsset ?? vscodeApiAsset;
  return `import{s as __toESM}from"./${chunkAsset}";
import{${reactExportName} as __reactFactory}from"./${reactAsset}";
import{${codexRequestExportName} as __post}from"./${requestAsset}";

var React=__toESM(__reactFactory(),1);
var h=React.createElement;
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
var NETWORK_MODE_OPTIONS=[
  {value:"disabled",label:"Closed"},
  {value:"local_only",label:"Local"},
  {value:"inherit_host",label:"Open"}
];

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
    cwd:"/workspace/project",
    mounts:[],
    network:{mode:"inherit_host"},
    require_enforced_policy:false,
    setup_commands:[],
    startup_apps:[]
  };
}

function defaultPermissions(){
  return {
    network:{mode:"inherit_host"},
    mounts:[],
    apps:{allow:[]}
  };
}

function normalizePermissions(value){
  var source=value&&typeof value==="object"&&!Array.isArray(value)?value:{};
  var network=source.network&&typeof source.network==="object"&&!Array.isArray(source.network)?source.network:{mode:"inherit_host"};
  var mode=typeof network.mode==="string"&&network.mode?network.mode:"inherit_host";
  var normalizedNetwork={mode:mode};
  if(mode==="local_only")normalizedNetwork.allow_hosts=Array.isArray(network.allow_hosts)?network.allow_hosts.map(String).filter(Boolean):[];
  return {
    network:normalizedNetwork,
    mounts:(Array.isArray(source.mounts)?source.mounts:[]).map(function(mount){
      return {
        host_path:String(mount?.host_path||""),
        workspace_path:String(mount?.workspace_path||""),
        mode:mount?.mode==="read_write"?"read_write":"read_only"
      };
    }).filter(function(mount){return mount.host_path&&mount.workspace_path;}),
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

function toggleButton(label,selected,disabled,onClick,tone){
  var selectedClass=selected
    ? tone==="readonly"
      ? "border-yellow-500/60 bg-yellow-500/10 text-yellow-800 dark:text-yellow-200"
      : "border-token-border-strong bg-token-main-surface-secondary text-token-text-primary"
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

function profileMounts(profile){
  return Array.isArray(profile?.mounts)?profile.mounts:[];
}

function profileMountMode(profile){
  var mounts=profileMounts(profile);
  if(mounts.length===0)return "inactive";
  var readOnly=mounts.some(function(mount){return mount?.mode==="read_only"||mount?.mode==null;});
  var readWrite=mounts.some(function(mount){return mount?.mode==="read_write";});
  if(readOnly&&!readWrite)return "read_only";
  if(readWrite&&!readOnly)return "read_write";
  return "mixed";
}

function mountModeLabel(mode){
  if(mode==="read_only")return "Read only";
  if(mode==="read_write")return "Read write";
  if(mode==="mixed")return "Mixed";
  return "No mounts";
}

function mountAccess(mount){
  return mount?.mode==="read_write"?"read_write":"read_only";
}

function safeWorkspacePathSegment(filePath){
  return (baseName(filePath).toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"")||"mount");
}

function defaultMountWorkspacePath(profile,filePath){
  var mounts=profileMounts(profile);
  var used=new Set(mounts.map(function(mount){return mount?.workspace_path;}).filter(Boolean));
  if(mounts.length===0&&typeof profile?.cwd==="string"&&profile.cwd.startsWith("/workspace/")&&!used.has(profile.cwd))return profile.cwd;
  var base="/workspace/"+safeWorkspacePathSegment(filePath);
  if(!used.has(base))return base;
  for(var index=2;index<100;index++){
    var candidate=base+"-"+index;
    if(!used.has(candidate))return candidate;
  }
  return base+"-"+Date.now();
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
  return profile?.description||profile?.cwd||profile?.network?.mode||"Saved profile";
}

function profileNetwork(profile){
  return profile?.network?.mode||"inherit_host";
}

function profileAllowHosts(profile){
  return Array.isArray(profile?.network?.allow_hosts)?profile.network.allow_hosts:[];
}

function networkHostListLabel(mode){
  return "Local hosts";
}

function networkHostPlaceholder(mode){
  return "localhost:3000";
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
  var toneClass=tone==="active"?"border-green-500/40 text-green-700 dark:text-green-300":tone==="stopped"?"border-red-500/40 text-red-700 dark:text-red-300":tone==="readonly"||tone==="warn"?"border-yellow-500/40 text-yellow-700 dark:text-yellow-300":"border-token-border-default text-token-text-tertiary";
  return h("span",{className:"inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs "+toneClass},showDot?statusDot(tone):null,label);
}

function statusDot(tone){
  var dotClass=tone==="active"?"bg-green-500":tone==="stopped"?"bg-red-500":tone==="readonly"||tone==="warn"?"bg-yellow-400":"bg-gray-400";
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

function approvalAckParams(bundle){
  var params={ackHiddenWorkspace:true};
  var requirements=(Array.isArray(bundle?.missing_acknowledgements)?bundle.missing_acknowledgements:[])
    .concat(Array.isArray(bundle?.required_acknowledgements)?bundle.required_acknowledgements:[])
    .concat(Array.isArray(bundle?.approve_mcp_parameters)?bundle.approve_mcp_parameters:[]);
  function applyAckName(value){
    var id=String(value||"");
    if(id==="unenforced_policy"||id==="acknowledge_unenforced_policy"||id==="ackUnenforcedPolicy"||id==="--ack-unenforced-policy")params.ackUnenforcedPolicy=true;
    if(id==="hidden_workspace"||id==="acknowledge_hidden_workspace"||id==="ackHiddenWorkspace"||id==="--ack-hidden-workspace")params.ackHiddenWorkspace=true;
  }
  requirements.forEach(function(requirement){
    applyAckName(requirement?.id);
    applyAckName(requirement?.name);
    applyAckName(requirement?.mcp_parameter?.name);
    applyAckName(requirement?.cli_flag);
  });
  (Array.isArray(bundle?.approve_cli_flags)?bundle.approve_cli_flags:[]).forEach(applyAckName);
  return params;
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
  var permissionHostState=React.useState("");
  var permissionHost=permissionHostState[0];
  var setPermissionHost=permissionHostState[1];
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
  var networkHostState=React.useState("");
  var networkHost=networkHostState[0];
  var setNetworkHost=networkHostState[1];
  var formModeState=React.useState("create");
  var formMode=formModeState[0];
  var setFormMode=formModeState[1];
  var detailState=React.useState(null);
  var workspaceDetail=detailState[0];
  var setWorkspaceDetail=detailState[1];
  var browserSessionState=React.useState(null);
  var browserSessionDraft=browserSessionState[0];
  var setBrowserSessionDraft=browserSessionState[1];
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
    __post("get-global-state",{params:{key:COMMAND_KEY}})
      .then(function(response){if(alive)setCommand(response?.value??"");})
      .catch(function(){});
    __post("get-global-state",{params:{key:PERMISSIONS_KEY}})
      .then(function(response){if(alive)setPermissionsPath(response?.value??"");})
      .catch(function(){});
    refresh().finally(function(){if(alive)setLoading(false);});
    return function(){alive=false;};
  },[refresh]);

  var profile=parseProfile(profileJson);
  var startupApps=profileStartupApps(profile);
  var mounts=profileMounts(profile);
  var mountMode=profileMountMode(profile);
  var networkMode=profileNetwork(profile);
  var networkHosts=profileAllowHosts(profile);
  var showNetworkHosts=networkMode==="local_only";
  var networkModeOptions=NETWORK_MODE_OPTIONS.some(function(option){return option.value===networkMode;})
    ? NETWORK_MODE_OPTIONS
    : [{value:networkMode,label:"Advanced: "+networkMode.replaceAll("_"," ")}].concat(NETWORK_MODE_OPTIONS);
  var permissionPolicy=normalizePermissions(permissionDraft);
  var permissionNetworkMode=permissionPolicy.network.mode||"inherit_host";
  var permissionNetworkHosts=Array.isArray(permissionPolicy.network.allow_hosts)?permissionPolicy.network.allow_hosts:[];
  var permissionMounts=permissionPolicy.mounts;
  var permissionApps=permissionPolicy.apps.allow;
  var showPermissionHosts=permissionNetworkMode==="local_only";
  var runningWorkspaces=workspaces.filter(workspaceRunning);
  var activeWorkspace=activeWorkspaceFromList(workspaces);
  var otherRunningWorkspaces=activeWorkspace?runningWorkspaces.slice(1):[];
  var stoppedWorkspaces=workspaces.filter(function(workspace){return !workspaceRunning(workspace);});
  var stoppedWorkspaceCount=stoppedWorkspaces.length;
  var editingSaved=formMode==="edit"&&!!selectedProfileId;
  var selectedProfileActive=editingSaved&&runningWorkspaces.some(function(workspace){return workspaceProfileId(workspace)===selectedProfileId||workspacePrimary(workspace)===selectedProfileId;});
  var profileFormLocked=selectedProfileActive;
  var startDisabled=!profile||!!activeWorkspace||!!pendingApproval||activeAction==="workspaceOpenProfile"||activeAction==="workspaceStart";

  async function saveCommand(){
    await __post("set-global-state",{params:{key:COMMAND_KEY,value:command.trim()||void 0}});
    await reconnectBackend();
  }

  async function savePermissions(){
    await __post("set-global-state",{params:{key:PERMISSIONS_KEY,value:permissionsPath.trim()||void 0}});
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
    await __post("set-global-state",{params:{key:PERMISSIONS_KEY,value:void 0}});
    await reconnectBackend();
  }

  async function reconnectBackend(){
    var doctor=await callAgentWorkspace("doctor");
    await refresh();
    setResult({ok:doctor?.ok!==false,action:"reconnect",json:{doctor:doctor?.json??doctor,refreshed:true}});
    setResultOpen(false);
  }

  async function installRuntime(){
    var install=await callAgentWorkspace("installRuntime",{timeoutMs:300000});
    if(install?.ok===false)return;
    setCommand("");
    await __post("set-global-state",{params:{key:COMMAND_KEY,value:void 0}});
    var doctor=await callAgentWorkspace("doctor");
    await refresh();
    setResult({ok:doctor?.ok!==false,action:"installRuntime",json:{install:install,doctor:doctor?.json??doctor,refreshed:true}});
    setResultOpen(false);
  }

  async function runBackendSmoke(){
    var responses=[];
    for(var action of ["doctor","guardrails","profilePath","profileList","workspaceList","permissionConfig"]){
      responses.push(await callAgentWorkspace(action));
    }
    var nextPermissionConfig=permissionConfigFromResponses(responses[5],responses[4]);
    setPermissionConfig(nextPermissionConfig||{configured:false,restricted:false,message:"No workspace permission file detected; Codex session permissions apply"});
    if(Array.isArray(responses[3]?.json?.profiles))setProfiles(responses[3].json.profiles);
    if(Array.isArray(responses[4]?.json?.workspaces))setWorkspaces(responses[4].json.workspaces);
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

  function setPermissionNetworkMode(mode){
    updatePermissionDraft(function(next){
      next.network={...(next.network||{}),mode:mode};
      if(mode!=="local_only")delete next.network.allow_hosts;
      else next.network.allow_hosts=Array.isArray(next.network.allow_hosts)?next.network.allow_hosts:[];
    });
  }

  function addPermissionHost(){
    var host=permissionHost.trim();
    if(!host)return;
    updatePermissionDraft(function(next){
      var network=next.network||{mode:"local_only"};
      var hosts=Array.isArray(network.allow_hosts)?network.allow_hosts:[];
      next.network={...network,mode:"local_only",allow_hosts:hosts.includes(host)?hosts:[...hosts,host]};
    });
    setPermissionHost("");
  }

  function removePermissionHost(index){
    updatePermissionDraft(function(next){
      var network=next.network||{};
      var hosts=Array.isArray(network.allow_hosts)?network.allow_hosts:[];
      next.network={...network,allow_hosts:hosts.filter(function(_,hostIndex){return hostIndex!==index;})};
    });
  }

  function addPermissionMountsFromPaths(paths){
    var selected=(Array.isArray(paths)?paths:[paths]).filter(function(filePath){return typeof filePath==="string"&&filePath.trim().length>0;});
    if(selected.length===0)return;
    updatePermissionDraft(function(next){
      var nextMounts=Array.isArray(next.mounts)?next.mounts:[];
      selected.forEach(function(filePath){
        if(nextMounts.some(function(mount){return mount?.host_path===filePath;}))return;
        var workspacePath=defaultMountWorkspacePath({mounts:nextMounts},filePath);
        nextMounts=[...nextMounts,{host_path:filePath,workspace_path:workspacePath,mode:"read_only"}];
      });
      next.mounts=nextMounts;
    });
  }

  function setPermissionMountMode(index,mode){
    updatePermissionDraft(function(next){
      next.mounts=(Array.isArray(next.mounts)?next.mounts:[]).map(function(mount,mountIndex){
        return mountIndex===index?{...mount,mode:mode}:mount;
      });
    });
  }

  function removePermissionMount(index){
    updatePermissionDraft(function(next){next.mounts=(Array.isArray(next.mounts)?next.mounts:[]).filter(function(_,mountIndex){return mountIndex!==index;});});
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

  async function pickPermissionMount(){
    try{
      var response=await __post("linux-agent-workspace-pick-mount",{params:{}});
      setResult(response);
      if(response?.ok)addPermissionMountsFromPaths(Array.isArray(response?.json?.paths)?response.json.paths:response?.json?.path);
    }catch(error){
      setResult({ok:false,action:"pickPermissionMount",message:error instanceof Error?error.message:String(error)});
    }
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
    setNetworkHost("");
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
      var pick=await __post("linux-agent-workspace-pick-mount",{params:{}});
      setResult(pick);
      var hostPath=pick?.json?.path;
      if(!pick?.ok||!hostPath)return;
      var base=hostPath.split(/[\\/]+/).filter(Boolean).pop()||"project-dev";
      var id=uniqueProfileId(base.toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"project-dev");
      var response=await callAgentWorkspace("profileTemplate",{templateKind:"project-dev",profileId:id,hostPath:hostPath});
      var template=profileFromResponse(response);
      openCreateProfileTemplate(template);
    }catch(error){
      setResult({ok:false,action:"pickMount",message:error instanceof Error?error.message:String(error)});
    }
  }

  async function createRestrictedChromeProfile(){
    var id=uniqueProfileId("restricted-chrome");
    var response=await callAgentWorkspace("profileTemplate",{templateKind:"restricted-chrome",profileId:id});
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
    }else if(!window.confirm("Use this browser data folder directly? Close the host browser first to avoid profile locks or corruption.")){
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
      setNetworkHost("");
      setAdvancedOpen(false);
      setEditingProfile(true);
    }
  }

  function setNetworkMode(mode){
    updateProfile(function(next){
      next.network={...(next.network||{}),mode:mode};
      if(mode!=="local_only")delete next.network.allow_hosts;
    });
  }

  function addMountsFromPaths(paths){
    var selected=(Array.isArray(paths)?paths:[paths]).filter(function(filePath){return typeof filePath==="string"&&filePath.trim().length>0;});
    if(selected.length===0)return;
    updateProfile(function(next){
      var nextMounts=profileMounts(next);
      selected.forEach(function(filePath){
        if(nextMounts.some(function(mount){return mount?.host_path===filePath;}))return;
        var workspacePath=defaultMountWorkspacePath({...next,mounts:nextMounts},filePath);
        nextMounts=[...nextMounts,{host_path:filePath,workspace_path:workspacePath,mode:"read_only"}];
        if(!next.cwd)next.cwd=workspacePath;
      });
      next.mounts=nextMounts;
    });
  }

  function setMountMode(index,mode){
    updateProfile(function(next){
      next.mounts=profileMounts(next).map(function(mount,mountIndex){
        return mountIndex===index?{...mount,mode:mode}:mount;
      });
    });
  }

  function removeMount(index){
    updateProfile(function(next){next.mounts=profileMounts(next).filter(function(_,mountIndex){return mountIndex!==index;});});
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

  function addNetworkHost(){
    var host=networkHost.trim();
    if(!host)return;
    updateProfile(function(next){
      var network=next.network||{};
      var hosts=Array.isArray(network.allow_hosts)?network.allow_hosts:[];
      next.network={...network,allow_hosts:hosts.includes(host)?hosts:[...hosts,host]};
    });
    setNetworkHost("");
  }

  function removeNetworkHost(index){
    updateProfile(function(next){
      var network=next.network||{};
      var hosts=Array.isArray(network.allow_hosts)?network.allow_hosts:[];
      next.network={...network,allow_hosts:hosts.filter(function(_,hostIndex){return hostIndex!==index;})};
    });
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

  async function pickMount(){
    try{
      var response=await __post("linux-agent-workspace-pick-mount",{params:{}});
      setResult(response);
      if(response?.ok)addMountsFromPaths(Array.isArray(response?.json?.paths)?response.json.paths:response?.json?.path);
    }catch(error){
      setResult({ok:false,action:"pickMount",message:error instanceof Error?error.message:String(error)});
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
    if(activeWorkspace||pendingApproval)return;
    var preview=await callAgentWorkspace(action,{...params,dryRun:true});
    if(!responseOk(preview))return;
    setPendingApproval({action:action,params:params,preview:preview,title:title});
  }

  async function approvePendingStart(){
    var pending=pendingApproval;
    if(!pending)return;
    var approval=approvalBundleFromResponse(pending.preview);
    var ackParams=approvalAckParams(approval);
    setPendingApproval(null);
    var startResponse=await callAgentWorkspace(pending.action,{...pending.params,...ackParams});
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
        permissionConfig?permissionConfigView(permissionConfig):null,
        h("section",{className:"rounded-md border border-token-border-default bg-token-main-surface-secondary p-3 text-sm"},
          h("div",{className:"mb-3 flex items-center justify-between gap-2"},
            h("div",{className:"font-medium text-token-text-primary"},"Permission rules"),
            h("div",{className:"flex gap-2"},
              statusPill(permissionNetworkMode.replaceAll("_"," "),"idle"),
              button("Save permissions",activeAction==="permissionSave",savePermissionRules)
            )
          ),
          h("div",{className:"grid gap-3 md:grid-cols-[220px_1fr]"},
            h("label",{className:"flex flex-col gap-1 text-sm text-token-text-secondary"},
              h("span",null,"Network ceiling"),
              h("select",{
                className:"h-9 rounded-md border border-token-border-default bg-token-bg-primary px-2 text-token-text-primary",
                value:permissionNetworkMode,
                onChange:function(event){setPermissionNetworkMode(event.target.value);}
              },
                NETWORK_MODE_OPTIONS.map(function(option){return h("option",{key:option.value,value:option.value},option.label);})
              )
            ),
            showPermissionHosts
              ? h("div",{className:"grid gap-2 md:grid-cols-[1fr_auto]"},
                  field("Local host",permissionHost,setPermissionHost,"localhost:3000"),
                  h("div",{className:"flex items-end"},button("Add host",!permissionHost.trim(),addPermissionHost))
                )
              : null
          ),
          showPermissionHosts&&permissionNetworkHosts.length>0
            ? h("div",{className:"mt-2 flex flex-wrap gap-2"},
                permissionNetworkHosts.map(function(host,index){
                  return h("span",{key:host+"-"+index,className:"inline-flex items-center gap-2 rounded-md border border-token-border-default px-2 py-1 text-token-text-primary"},
                    host,
                    button("Remove",false,function(){removePermissionHost(index);})
                  );
                })
              )
            : null,
          h("div",{className:"mt-3 flex flex-col gap-2 rounded-md border border-token-border-default p-3"},
            h("div",{className:"flex items-center justify-between gap-2"},
              h("div",{className:"text-sm font-medium text-token-text-primary"},"Allowed file access"),
              button("Add file/folder",false,pickPermissionMount)
            ),
            permissionMounts.length===0
              ? h("div",{className:"rounded-md border border-dashed border-token-border-default p-2 text-sm text-token-text-tertiary"},"No file access")
              : h("div",{className:"flex flex-col gap-2"},
                  permissionMounts.map(function(mount,index){
                    return h("div",{key:String(index),className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2 text-sm"},
                      h("div",{className:"min-w-0"},
                        h("div",{className:"truncate text-token-text-primary"},mount.host_path),
                        h("div",{className:"truncate text-token-text-tertiary"},mount.workspace_path)
                      ),
                      h("div",{className:"flex shrink-0 flex-wrap gap-2"},
                        toggleButton("Read only",mountAccess(mount)==="read_only",false,function(){setPermissionMountMode(index,"read_only");},"readonly"),
                        toggleButton("Read write",mountAccess(mount)==="read_write",false,function(){setPermissionMountMode(index,"read_write");}),
                        button("Remove",false,function(){removePermissionMount(index);})
                      )
                    );
                  })
                )
          ),
          h("div",{className:"mt-3 flex flex-col gap-2 rounded-md border border-token-border-default p-3"},
            h("div",{className:"flex items-center justify-between gap-2"},
              h("div",{className:"text-sm font-medium text-token-text-primary"},"Allowed apps"),
              button("Pick app",false,pickPermissionApp)
            ),
            permissionApps.length===0
              ? h("div",{className:"rounded-md border border-dashed border-token-border-default p-2 text-sm text-token-text-tertiary"},"No app allowlist")
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
                      button("Start",!!activeWorkspace||activeAction==="workspaceStart"||activeAction==="workspaceOpenProfile",function(){startStoppedWorkspace(workspace);}),
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
            button("Project template",activeAction==="profileTemplate",createProjectProfile),
            button("Chrome template",activeAction==="profileTemplate",createRestrictedChromeProfile),
            button("Browser session",activeAction==="profileTemplate",createBrowserSessionProfile),
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
                    activeForProfile?statusPill("Active","active",true):statusPill(profileNetwork(savedProfile),"idle")
                  ),
                  h("div",{className:"mt-1 truncate text-token-text-tertiary"},profileSummary(savedProfile)),
                  h("div",{className:"mt-3 flex gap-2"},
                    button(activeForProfile?"Running":"Start",!!activeWorkspace||activeAction==="workspaceOpenProfile",function(){startSavedWorkspace(savedProfile);}),
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
            h("div",{className:"rounded-md border border-yellow-500/30 bg-token-main-surface-secondary p-3 text-sm text-token-text-secondary"},"Browser profiles contain cookies and logged-in sessions. Copying the folder is safer for profile locks; direct use is for cases where you already made a dedicated browser profile."),
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
                h("div",{className:"mt-1 text-xs text-token-text-secondary"},"Mounts the selected folder read-write. Close the host browser first.")
              )
            ),
            h("div",{className:"flex flex-wrap justify-end gap-2"},
              button("Cancel",false,function(){setBrowserSessionDraft(null);}),
              button(browserSessionDraft.useCopy?"Create from copy":"Create direct",!browserSessionDraft.profileId?.trim()||activeAction==="profileTemplate",finishBrowserSessionProfile)
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
              field("Working folder",profile?.cwd||"",function(value){setProfileTextField("cwd",value);},"/workspace/project",profileFormLocked)
            ),
            h("div",{className:"grid gap-3 md:grid-cols-[220px_1fr]"},
              h("label",{className:"flex flex-col gap-1 text-sm text-token-text-secondary"},
                h("span",null,"Network"),
                h("select",{
                  className:"h-9 rounded-md border border-token-border-default bg-token-bg-primary px-2 text-token-text-primary disabled:cursor-not-allowed disabled:opacity-60",
                  value:networkMode,
                  onChange:function(event){setNetworkMode(event.target.value);},
                  disabled:profileFormLocked
                },
                  networkModeOptions.map(function(option){
                    return h("option",{key:option.value,value:option.value},option.label);
                  })
                )
              )
            ),
            h("div",{className:"flex flex-col gap-2 rounded-md border border-token-border-default p-3"},
              h("div",{className:"flex items-center justify-between gap-2"},
                h("div",{className:"min-w-0"},
                  h("div",{className:"text-sm font-medium text-token-text-primary"},"File access"),
                  h("div",{className:"truncate text-xs text-token-text-tertiary"},mounts.length===0?"No files or folders mounted":mountModeLabel(mountMode))
                ),
                button("Add file/folder",!profile||profileFormLocked,pickMount)
              ),
              mounts.length===0
                ? h("div",{className:"rounded-md border border-dashed border-token-border-default p-2 text-sm text-token-text-tertiary"},"Add a file or folder before choosing read-only or read-write access.")
                : h("div",{className:"flex flex-col gap-2"},
                    mounts.map(function(mount,index){
                      return h("div",{key:String(index),className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2 text-sm"},
                        h("div",{className:"min-w-0"},
                          h("div",{className:"truncate text-token-text-primary"},mount?.host_path||"Mounted path"),
                          h("div",{className:"truncate text-token-text-tertiary"},mount?.workspace_path||"/workspace/mount")
                        ),
                        h("div",{className:"flex shrink-0 flex-wrap gap-2"},
                          toggleButton("Read only",mountAccess(mount)==="read_only",profileFormLocked,function(){setMountMode(index,"read_only");},"readonly"),
                          toggleButton("Read write",mountAccess(mount)==="read_write",profileFormLocked,function(){setMountMode(index,"read_write");}),
                          button("Remove",profileFormLocked,function(){removeMount(index);})
                        )
                      );
                    })
                  )
            ),
            showNetworkHosts
              ? h("div",{className:"flex flex-col gap-2 rounded-md border border-token-border-default p-3"},
                  h("div",{className:"flex items-center justify-between gap-2"},
                    h("div",{className:"text-sm font-medium text-token-text-primary"},networkHostListLabel(networkMode)),
                    statusPill(networkHosts.length+" host"+(networkHosts.length===1?"":"s"),"idle")
                  ),
                  networkHosts.length===0
                    ? h("div",{className:"text-sm text-token-text-tertiary"},"No hosts")
                    : h("div",{className:"flex flex-col gap-2"},
                        networkHosts.map(function(host,index){
                          return h("div",{key:host+"-"+index,className:"flex items-center justify-between gap-2 rounded-md border border-token-border-default p-2 text-sm"},
                            h("div",{className:"truncate text-token-text-primary"},host),
                            button("Remove",profileFormLocked,function(){removeNetworkHost(index);})
                          );
                        })
                      ),
                  h("div",{className:"grid gap-2 md:grid-cols-[1fr_auto]"},
                    field("Host",networkHost,setNetworkHost,networkHostPlaceholder(networkMode),profileFormLocked),
                    h("div",{className:"flex items-end"},button("Add host",!networkHost.trim()||profileFormLocked,addNetworkHost))
                  )
                )
              : null,
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
                editingSaved?button("Save changes",!profile||profileFormLocked,function(){saveProfile(true);}):button("Create",!profile||profileFormLocked,function(){saveProfile(false);}),
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

export{AgentWorkspacesSettings,AgentWorkspacesSettings as default};
//# sourceMappingURL=${SETTINGS_ASSET}.map
`;
}

function webviewAssetsDir(extractedDir) {
  return path.join(extractedDir, "webview", "assets");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importBindings(source) {
  const bindings = new Map();
  const importPattern = /import\{([^}]+)\}from"\.\/([^"]+)"/g;
  let match;
  while ((match = importPattern.exec(source)) != null) {
    const [, specifiers, assetName] = match;
    for (const rawSpecifier of specifiers.split(",")) {
      const specifier = rawSpecifier.trim();
      if (specifier.length === 0) {
        continue;
      }
      const aliased = specifier.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliased != null) {
        bindings.set(aliased[2], { assetName, exportName: aliased[1] });
      } else {
        bindings.set(specifier, { assetName, exportName: specifier });
      }
    }
  }
  return bindings;
}

function inferRuntimeDependenciesFromSettingsSource(source) {
  const jsxLocal = source.match(/\(0,([A-Za-z_$][\w$]*)\.jsx\)/)?.[1] ?? null;
  const reactLocal = source.match(/\(0,([A-Za-z_$][\w$]*)\.useState\)/)?.[1] ?? null;
  if (jsxLocal == null || reactLocal == null) {
    return null;
  }

  const jsxFactoryLocal = source.match(
    new RegExp(`${escapeRegExp(jsxLocal)}=([A-Za-z_$][\\w$]*)\\(\\)`),
  )?.[1] ?? null;
  const reactFactoryLocal = source.match(
    new RegExp(`${escapeRegExp(reactLocal)}=[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*)\\(\\),1\\)`),
  )?.[1] ?? null;
  if (jsxFactoryLocal == null || reactFactoryLocal == null) {
    return null;
  }

  const bindings = importBindings(source);
  const reactBinding = bindings.get(reactFactoryLocal);
  if (bindings.get(jsxFactoryLocal) == null || reactBinding == null) {
    return null;
  }

  return {
    reactAsset: reactBinding.assetName,
    reactExportName: reactBinding.exportName,
  };
}

function inferRuntimeDependenciesFromSettingsAssets(assetsDir) {
  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => /^settings-page-.*\.js$/.test(name) || /(?:^|~)settings-page(?:[-~].*)?\.js$/.test(name))
    .sort();
  for (const candidate of candidates) {
    const dependencies = inferRuntimeDependenciesFromSettingsSource(
      fs.readFileSync(path.join(assetsDir, candidate), "utf8"),
    );
    if (dependencies != null) {
      return dependencies;
    }
  }
  return null;
}

function resolveAgentWorkspaceSettingsAsset(extractedDir) {
  const assetsDir = webviewAssetsDir(extractedDir);
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`missing webview assets directory ${assetsDir}`);
  }

  const runtimeDependencies = inferRuntimeDependenciesFromSettingsAssets(assetsDir);
  let reactAsset;
  let reactExportName;
  if (runtimeDependencies != null) {
    ({ reactAsset, reactExportName } = runtimeDependencies);
  } else {
    const jsxRuntimeAsset = findRequiredWebviewAsset(
      assetsDir,
      /^jsx-runtime-.*\.js$/,
      "react.transitional.element",
      "JSX runtime asset",
    );
    const jsxRuntimeSource = fs.readFileSync(path.join(assetsDir, jsxRuntimeAsset), "utf8");
    const jsxExportsReactFactory = /export\{[^}]*\bn\b/.test(jsxRuntimeSource);
    reactAsset = jsxExportsReactFactory
      ? jsxRuntimeAsset
      : findRequiredWebviewAsset(assetsDir, /^react-.*\.js$/, "react.transitional.element", "React asset");
    reactExportName = jsxExportsReactFactory ? "n" : "t";
  }
  const chunkAsset = findImportedAsset(assetsDir, reactAsset, "React shared chunk asset");
  const codexRequestAsset = findCodexRequestWebviewAsset(assetsDir);

  return {
    filePath: path.join(assetsDir, SETTINGS_ASSET),
    source: buildAgentWorkspaceSettingsSource({
      chunkAsset,
      reactAsset,
      reactExportName,
      codexRequestAsset: codexRequestAsset.assetName,
      codexRequestExportName: codexRequestAsset.exportName,
    }),
  };
}

function isAgentWorkspaceSettingsSharedMetadataBundleSource(currentSource) {
  return (
    currentSource.includes('"local-environments":{id:`settings.nav.local-environments`') &&
    currentSource.includes("settings.section.worktrees")
  );
}

function isAgentWorkspaceSettingsRouteBundleSource(currentSource) {
  return (
    currentSource.includes(SETTINGS_ASSET) ||
    /"general-settings":\(0,[A-Za-z_$][\w$]*\.lazy\)\(\(\)=>[A-Za-z_$][\w$]*\(/.test(currentSource)
  );
}

function isAgentWorkspaceSettingsNavigationBundleSource(currentSource) {
  return (
    /[A-Za-z_$][\w$]*=\{[^;]*"local-environments":[A-Za-z_$][\w$]*,[^;]*worktrees:/.test(currentSource) &&
    currentSource.includes("slugs:[`") &&
    currentSource.includes("`local-environments`") &&
    currentSource.includes("`worktrees`")
  );
}

function addAgentWorkspaceToSettingsSlugLists(currentSource) {
  return currentSource
    .replaceAll(
      "`local-environments`,`worktrees`",
      "`local-environments`,`agent-workspaces`,`worktrees`",
    )
    .replaceAll(
      "`local-environments`,`environments`,`worktrees`",
      "`local-environments`,`agent-workspaces`,`environments`,`worktrees`",
    );
}

function addAgentWorkspaceVisibilityCases(currentSource) {
  let patchedSource = currentSource;
  const replacements = [[
    "case`worktrees`:case`local-environments`:case`environments`:return",
    "case`worktrees`:case`local-environments`:case`agent-workspaces`:case`environments`:return",
  ]];

  for (const [needle, replacement] of replacements) {
    if (!patchedSource.includes(replacement) && patchedSource.includes(needle)) {
      patchedSource = patchedSource.replace(needle, replacement);
    }
  }

  return patchedSource;
}

function addAgentWorkspaceLoadingCases(currentSource) {
  let patchedSource = currentSource;
  const replacements = [[
    "case`local-environments`:case`worktrees`:case`environments`:",
    "case`local-environments`:case`agent-workspaces`:case`worktrees`:case`environments`:",
  ]];

  for (const [needle, replacement] of replacements) {
    if (!patchedSource.includes(replacement) && patchedSource.includes(needle)) {
      patchedSource = patchedSource.replace(needle, replacement);
    }
  }

  return patchedSource;
}

function applyAgentWorkspaceSettingsSharedPatch(currentSource) {
  let patchedSource = currentSource;
  if (!patchedSource.includes(`settings.nav.${SETTINGS_SLUG}`)) {
    const navNeedle =
      '"local-environments":{id:`settings.nav.local-environments`,defaultMessage:`Environments`,description:`Title for environments settings section`},';
    if (!patchedSource.includes(navNeedle)) {
      throw new Error("could not add agent workspace nav label");
    }
    patchedSource = patchedSource.replace(
      navNeedle,
      `${navNeedle}"${SETTINGS_SLUG}":{id:\`settings.nav.${SETTINGS_SLUG}\`,defaultMessage:\`Agent Workspaces\`,description:\`Title for Agent Workspaces settings section\`},`,
    );
  }

  if (!patchedSource.includes(`settings.section.${SETTINGS_SLUG}`)) {
    const sectionNeedle = "case`worktrees`:{";
    if (!patchedSource.includes(sectionNeedle)) {
      throw new Error("could not add agent workspace section title");
    }
    const sectionRendererMatch = patchedSource.match(
      /case`worktrees`:\{[\s\S]*?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{id:`settings\.section\.worktrees`/,
    );
    const jsxAlias = sectionRendererMatch?.[1] ?? "d";
    const messageComponent = sectionRendererMatch?.[2] ?? "n";
    patchedSource = patchedSource.replace(
      sectionNeedle,
      `case\`${SETTINGS_SLUG}\`:{return (0,${jsxAlias}.jsx)(${messageComponent},{id:\`settings.section.${SETTINGS_SLUG}\`,defaultMessage:\`Agent Workspaces\`,description:\`Title for Agent Workspaces settings section\`})}${sectionNeedle}`,
    );
  }
  return patchedSource;
}

function applyAgentWorkspaceSettingsIndexPatch(currentSource) {
  let patchedSource = currentSource;

  if (!patchedSource.includes(SETTINGS_ASSET)) {
    const routePattern = /"general-settings":(?=\(0,([A-Za-z_$][\w$]*)\.lazy\)\(\(\)=>([A-Za-z_$][\w$]*)\()/;
    if (!routePattern.test(patchedSource)) {
      throw new Error("could not add agent workspace settings route");
    }
    patchedSource = patchedSource.replace(
      routePattern,
      (_match, lazyAlias, preloadAlias) =>
        `"${SETTINGS_SLUG}":(0,${lazyAlias}.lazy)(()=>${preloadAlias}(()=>import(\`./${SETTINGS_ASSET}\`),[],import.meta.url)),"general-settings":`,
    );
  }

  return patchedSource;
}

function applyAgentWorkspaceSettingsPagePatch(currentSource) {
  let patchedSource = currentSource;

  // Reuse an existing icon alias instead of injecting a new minified-scope
  // symbol. Upstream can wrap the icon map in initializer closures, and a
  // dangling injected symbol breaks the whole Settings route.
  const agentWorkspaceIcon = patchedSource.match(/"local-environments":([A-Za-z_$][\w$]*)/)?.[1] ?? null;

  if (agentWorkspaceIcon != null) {
    patchedSource = patchedSource.replace(
      new RegExp(`"${SETTINGS_SLUG}":[A-Za-z_$][\\w$]*`),
      `"${SETTINGS_SLUG}":${agentWorkspaceIcon}`,
    );
  }

  if (
    !new RegExp(`[,{]"${SETTINGS_SLUG}":[A-Za-z_$][\\w$]*,worktrees`).test(patchedSource) &&
    /"local-environments":([A-Za-z_$][\w$]*),worktrees:/.test(patchedSource)
  ) {
    patchedSource = patchedSource.replace(
      /"local-environments":([A-Za-z_$][\w$]*),worktrees:/,
      `"local-environments":$1,"${SETTINGS_SLUG}":${agentWorkspaceIcon ?? "$1"},worktrees:`,
    );
  }

  patchedSource = addAgentWorkspaceToSettingsSlugLists(patchedSource);
  patchedSource = addAgentWorkspaceVisibilityCases(patchedSource);
  patchedSource = addAgentWorkspaceLoadingCases(patchedSource);

  if (!patchedSource.includes(`\`${SETTINGS_SLUG}\``)) {
    throw new Error("could not add agent workspace settings navigation");
  }

  return patchedSource;
}

function collectAgentWorkspaceRouteAndNavigationPatches(extractedDir) {
  const assetsDir = webviewAssetsDir(extractedDir);
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`missing webview assets directory ${assetsDir}`);
  }

  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) =>
      /^app-initial~app-main~.*\.js$/.test(name) ||
      /(?:^|~)settings-page(?:[-~].*)?\.js$/.test(name)
    )
    .sort();
  let metadataMatched = false;
  let routeMatched = false;
  let navigationMatched = false;
  const patches = [];

  for (const candidate of candidates) {
    const filePath = path.join(assetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    let patchedSource = currentSource;
    if (isAgentWorkspaceSettingsSharedMetadataBundleSource(currentSource)) {
      metadataMatched = true;
      patchedSource = applyAgentWorkspaceSettingsSharedPatch(patchedSource);
    }
    if (isAgentWorkspaceSettingsRouteBundleSource(currentSource)) {
      routeMatched = true;
      patchedSource = applyAgentWorkspaceSettingsIndexPatch(patchedSource);
    }
    if (isAgentWorkspaceSettingsNavigationBundleSource(currentSource)) {
      navigationMatched = true;
      patchedSource = applyAgentWorkspaceSettingsPagePatch(patchedSource);
    }
    if (patchedSource !== currentSource) {
      patches.push({ filePath, currentSource, patchedSource });
    }
  }

  if (!metadataMatched) {
    throw new Error("could not find webview settings metadata bundle");
  }
  if (!routeMatched) {
    throw new Error("could not find webview settings route bundle");
  }
  if (!navigationMatched) {
    throw new Error("could not find webview settings navigation bundle");
  }

  return patches;
}

function patchAgentWorkspaceSettingsAssets(extractedDir) {
  try {
    const settingsAsset = resolveAgentWorkspaceSettingsAsset(extractedDir);
    const previousSettingsSource = fs.existsSync(settingsAsset.filePath)
      ? fs.readFileSync(settingsAsset.filePath, "utf8")
      : null;
    const patches = collectAgentWorkspaceRouteAndNavigationPatches(extractedDir);

    fs.writeFileSync(settingsAsset.filePath, settingsAsset.source, "utf8");
    let changed = previousSettingsSource !== settingsAsset.source ? 1 : 0;
    for (const patch of patches) {
      if (patch.patchedSource !== patch.currentSource) {
        fs.writeFileSync(patch.filePath, patch.patchedSource, "utf8");
        changed += 1;
      }
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
  applyAgentWorkspaceMainBridgePatch,
  applyAgentWorkspaceSettingsIndexPatch,
  applyAgentWorkspaceSettingsPagePatch,
  applyAgentWorkspaceSettingsSharedPatch,
  buildAgentWorkspaceSettingsSource,
  patchAgentWorkspaceSettingsAssets,
};
