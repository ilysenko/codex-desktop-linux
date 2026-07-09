"use strict";

const { requireName } = require("../../scripts/patches/lib/minified-js.js");

const RECORD_REPLAY_PLUGIN_NAME = "record-and-replay";
const HUD_RUNTIME_VERSION = 5;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluginNameExpressionRegex(pluginName) {
  const escaped = escapeRegExp(pluginName);
  return String.raw`(?:\`${escaped}\`|"${escaped}"|'${escaped}')`;
}

function hasRecordReplayPluginGate(source) {
  const pluginGateArray = findBundledPluginGateArray(source);
  const target = pluginGateArray?.text ?? source;
  return new RegExp(
    String.raw`\{(?:[^{}]*,)?installWhenMissing:!0,name:${pluginNameExpressionRegex(RECORD_REPLAY_PLUGIN_NAME)},(?:isEnabled|isAvailable):`,
  ).test(target);
}

function buildRecordReplayDescriptor(availabilityProp) {
  return `{installWhenMissing:!0,name:\`${RECORD_REPLAY_PLUGIN_NAME}\`,${availabilityProp}:({platform:e})=>e===\`linux\`}`;
}

function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findBundledPluginGateArray(source) {
  let markerIndex = source.indexOf(".computerUse");
  while (markerIndex !== -1) {
    const openIndex = source.lastIndexOf("[", markerIndex);
    if (openIndex === -1) return null;
    const closeIndex = findMatchingBracket(source, openIndex);
    if (closeIndex !== -1 && markerIndex < closeIndex) {
      const text = source.slice(openIndex + 1, closeIndex);
      if (text.includes("installWhenMissing") && text.includes("name:") && /(?:isEnabled|isAvailable):/.test(text)) {
        return { start: openIndex + 1, end: closeIndex, text };
      }
    }
    markerIndex = source.indexOf(".computerUse", markerIndex + ".computerUse".length);
  }
  return null;
}

function findAlwaysOnBundledDescriptor(pluginGateArray) {
  const pluginNameExpression = "(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?|`[^`]+`|\"[^\"]+\"|'[^']+')";
  const regex = new RegExp(String.raw`\{name:(${pluginNameExpression}),(isEnabled|isAvailable):\(\)=>!0\}`, "g");
  let lastMatch = null;
  for (const match of pluginGateArray.text.matchAll(regex)) lastMatch = match;
  return lastMatch;
}

function applyRecordReplayPluginGatePatch(currentSource) {
  if (hasRecordReplayPluginGate(currentSource)) {
    return currentSource;
  }
  const pluginGateArray = findBundledPluginGateArray(currentSource);
  if (pluginGateArray == null) {
    throw new Error("Optional Record & Replay plugin gate patch drift: could not find expected upstream .computerUse plugin descriptor array");
  }
  const match = findAlwaysOnBundledDescriptor(pluginGateArray);
  if (match == null) {
    throw new Error("Optional Record & Replay plugin gate patch drift: could not find bundled plugin descriptor insertion point");
  }
  const [_descriptor, _pluginName, availabilityProp] = match;
  const insertionIndex = pluginGateArray.start + match.index;
  return `${currentSource.slice(0, insertionIndex)}${buildRecordReplayDescriptor(availabilityProp)},${currentSource.slice(insertionIndex)}`;
}

function recordReplayBridgeSource({ childProcessVar, fsVar, pathVar }) {
  return [
    `"chronicle-permissions":async()=>{let e=await codexLinuxChronicleSidecarControlStateAsync(),t=e.enabled===!0?"granted":"unknown";return{accessibility:t,screenRecording:t,chronicleSidecarPresent:e.enabled===!0,chronicleSidecarProcessState:e.state??"disabled",chronicleOcrAvailable:e.chronicleOcrAvailable===!0,chronicleOcrStatus:e.chronicleOcrStatus??"unknown",chronicleOcrBackend:e.chronicleOcrBackend??null,chronicleOcrLanguage:e.chronicleOcrLanguage??null}}`,
    `"getChronicleSidecarControlState":async()=>codexLinuxChronicleSidecarControlStateAsync()`,
    `"toggleChronicleSidecar":async()=>codexLinuxChronicleToggleSidecar()`,
    `"linux-record-replay-doctor":async()=>codexLinuxRecordReplayRun([${JSON.stringify("doctor")}],15000)`,
    `"linux-record-replay-status":async()=>codexLinuxRecordReplayRun([${JSON.stringify("status")}],5000)`,
    `"linux-record-replay-start":async({sessionDir:e,appId:t,windowId:n,goal:r,includeScreenshot:a,includeAccessibility:o,includeAudio:s}={})=>{let i=codexLinuxRecordReplayString(e);if(!i)return{ok:!1,action:"record.start",message:"sessionDir is required"};let c=["record","start","--session-dir",i];t&&c.push("--app-id",String(t));n&&c.push("--window-id",String(n));r&&c.push("--goal",String(r));a===!1&&c.push("--no-screenshot");o===!1&&c.push("--no-accessibility");s===!0&&c.push("--audio");s===!1&&c.push("--no-audio");return codexLinuxRecordReplayRun(c,60000)}`,
    `"linux-record-replay-skysight-start":async({intervalSeconds:e,summaryAgent:t}={})=>{let n=["skysight","start"];e&&n.push("--interval-seconds",String(e));t===!0&&n.push("--summary-agent","enabled");t===!1&&n.push("--summary-agent","disabled");return codexLinuxRecordReplayRun(n,15000)}`,
    `"linux-record-replay-skysight-status":async()=>codexLinuxRecordReplayRun(["skysight","status"],5000)`,
    `"linux-record-replay-skysight-pause":async()=>codexLinuxRecordReplayRun(["skysight","pause"],10000)`,
    `"linux-record-replay-skysight-resume":async()=>codexLinuxRecordReplayRun(["skysight","resume"],10000)`,
    `"linux-record-replay-skysight-stop":async()=>codexLinuxRecordReplayRun(["skysight","stop"],10000)`,
    `"linux-record-replay-skysight-snapshot":async({source:e}={})=>{let t=["skysight","snapshot"];e&&t.push("--source",String(e));return codexLinuxRecordReplayRun(t,15000)}`,
    `"linux-record-replay-skysight-list-exclusions":async()=>codexLinuxRecordReplayRun(["skysight","list-exclusions"],5000)`,
    `"linux-record-replay-skysight-update-exclusion":async({kind:e,value:t,reason:n,remove:r}={})=>{let a=codexLinuxRecordReplayString(e),o=codexLinuxRecordReplayString(t);if(!a||!o)return{ok:!1,action:"skysight.update-exclusion",message:"kind and value are required"};let s=["skysight","update-exclusion","--kind",a,"--value",o];n&&s.push("--reason",String(n));r&&s.push("--remove");return codexLinuxRecordReplayRun(s,10000)}`,
    `"linux-record-replay-mark":async({sessionDir:e,note:t}={})=>{let n=codexLinuxRecordReplayString(e),r=codexLinuxRecordReplayString(t);if(!n||!r)return{ok:!1,action:"record.mark",message:"sessionDir and note are required"};return codexLinuxRecordReplayRun(["record","mark","--session-dir",n,"--note",r],15000)}`,
    `"linux-record-replay-speech-context":async({sessionDir:e,transcript:t,source:n}={})=>{let r=codexLinuxRecordReplayString(e),a=codexLinuxRecordReplayString(t);if(!r||!a)return{ok:!1,action:"record.speech",message:"sessionDir and transcript are required"};let o=["record","speech","--session-dir",r,"--text",a];n&&o.push("--source",String(n));return codexLinuxRecordReplayRun(o,15000)}`,
    recordReplayActiveSpeechContextBridgeHandler(),
    `"linux-record-replay-browser-trace":async({sessionDir:e,trace:t,traceJson:n,url:r,title:a,source:o}={})=>{let s=codexLinuxRecordReplayString(e),i=codexLinuxRecordReplayString(n);if(!s)return{ok:!1,action:"record.browser-trace",message:"sessionDir is required"};if(!i&&t!==void 0)i=JSON.stringify(t);if(!i)return{ok:!1,action:"record.browser-trace",message:"trace or traceJson is required"};let c=codexLinuxRecordReplayWriteTempJson(i),l=["record","browser-trace","--session-dir",s,"--trace-file",c];r&&l.push("--url",String(r));a&&l.push("--title",String(a));o&&l.push("--source",String(o));try{return await codexLinuxRecordReplayRun(l,30000)}finally{try{${fsVar}.unlinkSync(c)}catch{}}}`,
    `"linux-record-replay-desktop-snapshot":async({sessionDir:e,source:t}={})=>{let n=codexLinuxRecordReplayString(e);if(!n)return{ok:!1,action:"record.desktop-snapshot",message:"sessionDir is required"};let r=["record","desktop-snapshot","--session-dir",n];t&&r.push("--source",String(t));return codexLinuxRecordReplayRun(r,15000)}`,
    `"linux-record-replay-stop":async({sessionDir:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"record.stop",message:"sessionDir is required"};return codexLinuxRecordReplayRun(["record","stop","--session-dir",t],15000)}`,
    `"linux-record-replay-stop-active":async()=>{let e=await codexLinuxRecordReplayRun(["status"],5000),t=e?.json?.session_dir;if(!e?.ok||e?.json?.state!==\`active\`||!t)return{ok:!1,action:"record.stop-active",message:"No active Record & Replay session"};return codexLinuxRecordReplayRun(["record","stop","--session-dir",String(t)],15000)}`,
    `"linux-record-replay-cancel":async({sessionDir:e,discarded:t}={})=>{let n=codexLinuxRecordReplayString(e);if(!n)return{ok:!1,action:"record.cancel",message:"sessionDir is required"};let r=["record","cancel","--session-dir",n];t&&r.push("--discarded");return codexLinuxRecordReplayRun(r,15000)}`,
    `"linux-record-replay-cancel-active":async({discarded:e}={})=>{let t=await codexLinuxRecordReplayRun(["status"],5000),n=t?.json?.session_dir;if(!t?.ok||t?.json?.state!==\`active\`||!n)return{ok:!1,action:"record.cancel-active",message:"No active Record & Replay session"};let r=["record","cancel","--session-dir",String(n)];e&&r.push("--discarded");return codexLinuxRecordReplayRun(r,15000)}`,
    `"linux-record-replay-bundle":async({bundle:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"bundle.validate",message:"bundle is required"};return codexLinuxRecordReplayRun(["bundle","validate","--bundle",t],15000)}`,
    `"linux-record-replay-draft-skill":async({bundle:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"bundle.draft-prompt",message:"bundle is required"};return codexLinuxRecordReplayRun(["bundle","draft-prompt","--bundle",t],30000)}`,
    `"linux-record-replay-import-skill":async({source:e,dryRun:t,allowUnsupported:n}={})=>{let r=codexLinuxRecordReplayString(e);if(!r)return{ok:!1,action:"skill.import",message:"source is required"};let a=["skill","import","--source",r];t&&a.push("--dry-run");n&&a.push("--allow-unsupported");return codexLinuxRecordReplayRun(a,30000)}`,
    `"linux-record-replay-inspect-skill":async({source:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"skill.inspect",message:"source is required"};return codexLinuxRecordReplayRun(["skill","inspect","--source",t],15000)}`,
  ].join(",");
}

function recordReplayActiveSpeechContextBridgeHandler() {
  return `"linux-record-replay-speech-context-active":async({transcript:e,source:t}={})=>{let n=codexLinuxRecordReplayString(e);if(!n)return{ok:!1,action:"record.speech-active",message:"transcript is required"};let r=await codexLinuxRecordReplayRun(["status"],5000),a=r?.json?.session_dir;if(!r?.ok||r?.json?.state!==\`active\`||!a)return{ok:!1,action:"record.speech-active",message:"No active Record & Replay session",status:r};let o=["record","speech","--session-dir",String(a),"--text",n];t&&o.push("--source",String(t));return codexLinuxRecordReplayRun(o,15000)}`;
}

function recordReplayHelperSource({ childProcessVar, fsVar, pathVar }) {
  return `function codexLinuxRecordReplayString(e){return typeof e==="string"&&e.trim().length>0?e.trim():null}
function codexLinuxRecordReplayBin(){let e=codexLinuxRecordReplayString(process.env.CODEX_RECORD_REPLAY_LINUX_BIN);if(e)return e;let t=[];try{process.resourcesPath&&t.push(${pathVar}.join(process.resourcesPath,"native","codex-record-replay-linux"))}catch{}try{t.push(${pathVar}.join(process.cwd(),"resources","native","codex-record-replay-linux"))}catch{}try{let e=process.env.PATH||"";for(let n of e.split(${pathVar}.delimiter))n&&t.push(${pathVar}.join(n,"codex-record-replay-linux"))}catch{}t.push("codex-record-replay-linux");for(let e of t){try{if(e==="codex-record-replay-linux"||${fsVar}.existsSync(e))return e}catch{}}return "codex-record-replay-linux"}
function codexLinuxRecordReplayParse(e){let t=String(e||"").trim();if(!t)return null;try{return JSON.parse(t)}catch{return{raw:t}}}
function codexLinuxRecordReplayWriteTempJson(e){let t=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||"/tmp",n=${pathVar}.join(t,"codex-record-replay-traces-"+(process.getuid?process.getuid():process.pid));${fsVar}.mkdirSync(n,{recursive:true,mode:448});try{if(${fsVar}.lstatSync(n).isSymbolicLink())throw Error("trace directory is a symlink");${fsVar}.chmodSync(n,448)}catch(r){throw r}let r=${pathVar}.join(n,"trace-"+Date.now()+"-"+process.pid+"-"+Math.random().toString(36).slice(2)+".json");${fsVar}.writeFileSync(r,String(e),{mode:384});return r}
function codexLinuxRecordReplayRun(e,t){let n=codexLinuxRecordReplayBin();return new Promise(r=>{${childProcessVar}.execFile(n,e,{encoding:"utf8",timeout:t,maxBuffer:16777216},(t,a,o)=>{let s=codexLinuxRecordReplayParse(a);if(t)return r({ok:!1,command:n,args:e,message:t instanceof Error?t.message:String(t),code:t?.code??null,stdout:a||"",stderr:o||"",json:s});r({ok:!0,command:n,args:e,stdout:a||"",stderr:o||"",json:s})})})}
${recordReplayChronicleHelperSource({ childProcessVar })}`;
}

function recordReplayChronicleHelperSource({ childProcessVar }) {
  return `function codexLinuxRecordReplayRunSync(e,t){let n=codexLinuxRecordReplayBin();try{let r=${childProcessVar}.execFileSync(n,e,{encoding:"utf8",timeout:t,maxBuffer:16777216});return{ok:!0,command:n,args:e,stdout:r||"",stderr:"",json:codexLinuxRecordReplayParse(r)}}catch(r){let a=typeof r?.stdout==="string"?r.stdout:r?.stdout?String(r.stdout):"",o=typeof r?.stderr==="string"?r.stderr:r?.stderr?String(r.stderr):"";return{ok:!1,command:n,args:e,message:r instanceof Error?r.message:String(r),code:r?.status??r?.code??null,stdout:a,stderr:o,json:codexLinuxRecordReplayParse(a)}}}
function codexLinuxChronicleControlStateFromSkysight(e){let t=e?.json&&typeof e.json==="object"?e.json:null;if(!e?.ok&&t==null)return{enabled:!1,running:!1,state:"disabled"};let n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused",o=n==="running"&&r&&!a;return{enabled:!0,running:o,state:o?"running":"stopped",skysight:t,chronicleOcrAvailable:t?.ocr_available===!0||t?.ocrAvailable===!0,chronicleOcrStatus:t?.ocr_status??t?.ocrStatus??"unknown",chronicleOcrBackend:t?.ocr_backend??t?.ocrBackend??null,chronicleOcrLanguage:t?.ocr_language??t?.ocrLanguage??null}}
function codexLinuxChronicleSidecarControlState(){return codexLinuxChronicleControlStateFromSkysight(codexLinuxRecordReplayRunSync(["skysight","status"],3000))}
async function codexLinuxChronicleSidecarControlStateAsync(){return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","status"],5000))}
function codexLinuxChronicleSummaryAgentArgs(e){return e===!0?["--summary-agent","enabled"]:e===!1?["--summary-agent","disabled"]:[]}
async function codexLinuxChronicleEnsureSidecarRunning(e){let t=await codexLinuxRecordReplayRun(["skysight","status"],5000),n=t?.json&&typeof t.json==="object"?t.json:null,r=String(n?.state||""),a=n?.is_running===!0||n?.isRunning===!0,o=n?.paused===!0||n?.is_paused===!0||n?.isPaused===!0||r==="paused",s=codexLinuxChronicleSummaryAgentArgs(e),i=e===!0&&(n?.summary_agent_enabled!==!0&&n?.summaryAgentEnabled!==!0);if(r==="running"&&a&&!o)return i?codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000)):codexLinuxChronicleControlStateFromSkysight(t);if(a&&o){i&&await codexLinuxRecordReplayRun(["skysight","start",...s],15000);return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","resume"],10000))}return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000))}
async function codexLinuxChronicleToggleSidecar(){let e=await codexLinuxRecordReplayRun(["skysight","status"],5000),t=e?.json&&typeof e.json==="object"?e.json:null,n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused";if(n==="running"&&r&&!a)return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","pause"],10000));if(r&&a)return codexLinuxChronicleEnsureSidecarRunning(!0);return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start","--summary-agent","enabled"],15000))}`;
}

function upgradeRecordReplayBridgeSource(currentSource) {
  const patchName = "Record & Replay main bridge patch";
  let patchedSource = currentSource;
  const childProcessVar = requireName(currentSource, "node:child_process");
  if (!patchedSource.includes("function codexLinuxChronicleControlStateFromSkysight")) {
    if (childProcessVar == null) {
      warn("Could not find Node child_process alias for Chronicle bridge upgrade", patchName);
    } else {
      patchedSource = `${recordReplayChronicleHelperSource({ childProcessVar })}\n${patchedSource}`;
    }
  }

  if (!patchedSource.includes('"linux-record-replay-speech-context-active":async')) {
    const browserTraceNeedle = `"linux-record-replay-browser-trace":async`;
    if (!patchedSource.includes(browserTraceNeedle)) {
      warn("Could not find active speech-context bridge upgrade point", patchName);
    } else {
      patchedSource = patchedSource.replace(
        browserTraceNeedle,
        `${recordReplayActiveSpeechContextBridgeHandler()},${browserTraceNeedle}`,
      );
    }
  }

  const hasChronicleHelpers = patchedSource.includes("function codexLinuxChronicleControlStateFromSkysight");
  if (!patchedSource.includes('"chronicle-permissions":async')) {
    const doctorNeedle = `"linux-record-replay-doctor":async`;
    if (!patchedSource.includes(doctorNeedle)) {
      warn("Could not find Chronicle bridge upgrade point", patchName);
    } else if (!hasChronicleHelpers) {
      warn("Could not install Chronicle bridge handlers without helper functions", patchName);
    } else {
      patchedSource = patchedSource.replace(
        doctorNeedle,
        `${recordReplayBridgeSource({ childProcessVar, fsVar: "fs", pathVar: "path" }).split(`,"linux-record-replay-doctor":async`)[0]},${doctorNeedle}`,
      );
    }
  }

  return patchedSource;
}

function applyRecordReplayChronicleTrayPatch(currentSource) {
  const patchName = "Record & Replay Chronicle tray bridge patch";
  if (currentSource.includes("process.platform===`linux`?codexLinuxChronicleSidecarControlState()")) {
    return currentSource;
  }

  const trayControlPattern =
    /getChronicleSidecarControlState:\(\)=>([A-Za-z_$][\w$]*\.appServerConnectionRegistry\.getMaybeConnection\(`local`\)\?\.getChronicleSidecarControlState\(\)\?\?([A-Za-z_$][\w$]*)),toggleChronicleSidecar:async\(\)=>\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\.appServerConnectionRegistry\.getMaybeConnection\([A-Za-z_$][\w$]*\));return \3==null\?\2:\3\.getChronicleSidecarControlState\(\)\.running\?\3\.pauseChronicleSidecar\(\):\3\.resumeChronicleSidecar\(\)\}/u;
  if (!trayControlPattern.test(currentSource)) {
    warn("Could not find Chronicle tray control callbacks", patchName);
    return currentSource;
  }

  return currentSource.replace(
    trayControlPattern,
    (
      _match,
      upstreamStateExpression,
      disabledStateVar,
      connectionVar,
      connectionExpression,
    ) =>
      `getChronicleSidecarControlState:()=>process.platform===\`linux\`?codexLinuxChronicleSidecarControlState():${upstreamStateExpression},toggleChronicleSidecar:async()=>{if(process.platform===\`linux\`)return codexLinuxChronicleToggleSidecar();let ${connectionVar}=${connectionExpression};return ${connectionVar}==null?${disabledStateVar}:${connectionVar}.getChronicleSidecarControlState().running?${connectionVar}.pauseChronicleSidecar():${connectionVar}.resumeChronicleSidecar()}`,
  );
}

function applyRecordReplayMainBridgePatch(currentSource) {
  const patchName = "Record & Replay main bridge patch";
  let patchedSource = currentSource;
  if (currentSource.includes('"linux-record-replay-doctor":async')) {
    return applyRecordReplayChronicleTrayPatch(upgradeRecordReplayBridgeSource(currentSource));
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
    warn("Could not find global-state bridge insertion point", patchName);
    return currentSource;
  }

  patchedSource = `${recordReplayHelperSource({ childProcessVar, fsVar, pathVar })}\n${patchedSource.replace(
    handlerNeedle,
    `${recordReplayBridgeSource({ childProcessVar, fsVar, pathVar })},${handlerNeedle}`,
  )}`;
  return applyRecordReplayChronicleTrayPatch(patchedSource);
}

function recordReplayHudRuntimeSource() {
  return [
    `;(()=>{`,
    `const VERSION=${HUD_RUNTIME_VERSION};`,
    `if(globalThis.codexLinuxRecordReplayHudVersion===VERSION)return;`,
    `globalThis.codexLinuxRecordReplayHudVersion=VERSION;`,
    `let seq=0,pending=new Map,hud=null,timer=null,lastStatus=null,stopping=false,canceling=false,capturedTranscripts=new Set,pendingTranscripts=[],desktopSnapshotInFlight=false,lastDesktopSnapshotAt=0;`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!=="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);clearTimeout(n.timer);if(t.responseType==="success"){let e=null;try{e=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve(e)}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,event=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){event.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(event)}`,
    `function post(method,params,timeoutMs=4000){let requestId="codex-linux-record-replay-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+method,body:JSON.stringify(params??{})};return new Promise((resolve,reject)=>{let timer=setTimeout(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);pending.set(requestId,{resolve,reject,timer});dispatch(payload)})}`,
    `function installStyle(){if(document.getElementById("codex-linux-record-replay-hud-style"))return;let s=document.createElement("style");s.id="codex-linux-record-replay-hud-style";s.textContent=".codex-linux-record-replay-hud{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483002;height:42px;min-width:166px;display:none;align-items:center;gap:10px;padding:0 8px 0 12px;border-radius:14px;background:rgba(49,49,52,.94);border:1px solid rgba(255,255,255,.08);box-shadow:0 14px 34px rgba(0,0,0,.26);color:#f4f4f5;font:600 12px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,\\"Segoe UI\\",sans-serif;pointer-events:auto;-webkit-app-region:no-drag;backdrop-filter:blur(16px)}.codex-linux-record-replay-hud[data-active=\\"true\\"]{display:flex}.codex-linux-record-replay-dot{width:14px;height:14px;border-radius:999px;border:2px solid rgba(239,82,72,.62);position:relative;box-sizing:border-box}.codex-linux-record-replay-dot::after{content:\\"\\";position:absolute;inset:2px;border-radius:999px;background:#ef4444}.codex-linux-record-replay-time{min-width:29px;color:#ef4444;font-variant-numeric:tabular-nums}.codex-linux-record-replay-btn{width:28px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:0;border-left:1px solid rgba(255,255,255,.08);border-radius:0;background:transparent;color:#d4d4d8;cursor:pointer}.codex-linux-record-replay-btn:hover{color:#fff;background:rgba(255,255,255,.06);border-radius:8px}.codex-linux-record-replay-btn:disabled{opacity:.6;cursor:default}.codex-linux-record-replay-btn svg{width:16px;height:16px}.codex-linux-record-replay-grip{width:18px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-left:1px solid rgba(255,255,255,.08);color:#a1a1aa}.codex-linux-record-replay-grip::before{content:\\"\\";width:3px;height:18px;border-radius:999px;background:linear-gradient(to bottom,#a1a1aa 0 2px,transparent 2px 5px,#a1a1aa 5px 7px,transparent 7px 10px,#a1a1aa 10px 12px,transparent 12px 15px,#a1a1aa 15px 17px)}";document.head?.appendChild?.(s)}`,
    `function ensureHud(){if(hud&&document.contains(hud))return hud;installStyle();let root=document.createElement("div");root.id="codex-linux-record-replay-hud";root.className="codex-linux-record-replay-hud";root.setAttribute("role","status");root.setAttribute("aria-live","polite");root.innerHTML='<span class="codex-linux-record-replay-dot" aria-hidden="true"></span><span class="codex-linux-record-replay-time">0:00</span><button type="button" class="codex-linux-record-replay-btn codex-linux-record-replay-finish" title="Finish recording" aria-label="Finish Record & Replay recording"><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"></rect></svg></button><button type="button" class="codex-linux-record-replay-btn codex-linux-record-replay-discard" title="Discard recording" aria-label="Discard Record & Replay recording"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M5 6l1 15h12l1-15"></path></svg></button><span class="codex-linux-record-replay-grip" aria-hidden="true"></span>';root.querySelector(".codex-linux-record-replay-finish")?.addEventListener("click",finishRecording);root.querySelector(".codex-linux-record-replay-discard")?.addEventListener("click",discardRecording);(document.body||document.documentElement).appendChild(root);hud=root;return root}`,
    `function findComposer(){let anchors=document.querySelectorAll?.("[data-composer-attachments-row],textarea,[contenteditable='true'],[data-above-composer-portal],[data-above-composer-queue-portal]")??[];for(let i=anchors.length-1;i>=0;i--){let a=anchors[i],t=a.closest?.("form,[data-composer-overlay-floating-ui],[class*='composer']")||a.parentElement;if(t&&document.body?.contains?.(t)&&t.getBoundingClientRect)return t}return null}`,
    `function findComposerEditor(root){let scope=root||document;let candidates=scope.querySelectorAll?.("textarea,[contenteditable='true'],[role='textbox']")??[];for(let i=candidates.length-1;i>=0;i--){let e=candidates[i],rect=e.getBoundingClientRect?.();if(e&&!e.disabled&&(!rect||rect.width>0&&rect.height>0))return e}return null}`,
    `function setNativeValue(el,value){let proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLInputElement?HTMLInputElement.prototype:null,desc=proto?Object.getOwnPropertyDescriptor(proto,"value"):null;if(desc?.set)desc.set.call(el,value);else el.value=value;el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}));el.dispatchEvent(new Event("change",{bubbles:true}))}`,
    `function setEditorText(el,value){el.focus?.();if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){setNativeValue(el,value);return true}if(el.isContentEditable||el.getAttribute?.("role")==="textbox"){try{document.execCommand?.("selectAll",false,null);document.execCommand?.("insertText",false,value)}catch{el.textContent=value;el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}))}return true}return false}`,
    `function findSendButton(root){let scope=root||document,candidates=[...scope.querySelectorAll?.("button,[role='button']")??[]];for(let i=candidates.length-1;i>=0;i--){let b=candidates[i],label=(b.getAttribute?.("aria-label")||b.title||b.textContent||"").trim().toLowerCase();if(b.disabled||b.getAttribute?.("aria-disabled")==="true")continue;if(/\\b(send|submit|resume)\\b/.test(label))return b}let form=root?.closest?.("form")||root?.querySelector?.("form");let submit=form?.querySelector?.("button[type='submit']:not([disabled])");return submit||null}`,
    `async function submitDoneMessage(){let composer=findComposer(),editor=findComposerEditor(composer)||findComposerEditor(document);if(!editor)return false;let text="I'm done recording.";if(!setEditorText(editor,text))return false;await new Promise(r=>setTimeout(r,120));let button=findSendButton(composer)||findSendButton(document);if(button){button.click();return true}let eventInit={key:"Enter",code:"Enter",which:13,keyCode:13,bubbles:true,cancelable:true};editor.dispatchEvent(new KeyboardEvent("keydown",eventInit));editor.dispatchEvent(new KeyboardEvent("keyup",eventInit));return true}`,
    `function resetHudPosition(){if(!hud)return;hud.style.left="50%";hud.style.bottom="96px";hud.style.transform="translateX(-50%)"}`,
    `function positionHud(){if(!hud||hud.dataset.active!=="true")return;resetHudPosition();let target=findComposer();if(!target)return;let rect=target.getBoundingClientRect(),width=window.innerWidth||document.documentElement?.clientWidth||0,height=window.innerHeight||document.documentElement?.clientHeight||0;if(!width||!height||rect.width<160||rect.height<24||rect.top<0||rect.top>height)return;let left=Math.max(90,Math.min(width-90,rect.left+rect.width/2)),bottom=Math.max(72,Math.min(260,height-rect.top+8));hud.style.left=left+"px";hud.style.bottom=bottom+"px"}`,
    `function statusFrom(body){let s=body?.json?.state?body.json:body?.state?body:null;return s&&typeof s==="object"?s:null}`,
    `function active(s){if(!s||s.state!=="active")return false;if(s.expires_at&&Date.now()>Date.parse(s.expires_at))return false;return true}`,
    `function sessionDirFrom(s){return s?.session_dir||s?.sessionDirectoryPath||s?.runtimeStatus?.session_dir||null}`,
    `function compactTranscript(e){return String(e||"").replace(/\\s+/g," ").trim()}`,
    `function rememberTranscriptKey(e){capturedTranscripts.add(e);if(capturedTranscripts.size>120)capturedTranscripts.delete(capturedTranscripts.values().next().value)}`,
    `function normalizeTranscript(text,action){let transcript=compactTranscript(text);if(!transcript||action==="discard")return null;return{transcript,action:String(action||"unknown"),queuedAt:Date.now(),attempts:0}}`,
    `function rememberPendingTranscript(item){pendingTranscripts.push(item);if(pendingTranscripts.length>60)pendingTranscripts.shift();return true}`,
    `function drainBootstrapTranscriptQueue(){let q=globalThis.codexLinuxRecordReplayPendingTranscripts;if(!Array.isArray(q)||q.length===0)return;globalThis.codexLinuxRecordReplayPendingTranscripts=[];for(let entry of q){let transcript=typeof entry==="string"?entry:entry?.transcript,action=typeof entry==="object"?entry.action:"unknown",queuedAt=typeof entry==="object"&&Number.isFinite(entry.queuedAt)?entry.queuedAt:Date.now(),item=normalizeTranscript(transcript,action);item&&(item.queuedAt=queuedAt,rememberPendingTranscript(item))}}`,
    `async function writeTranscript(item){let transcript=item.transcript,action=item.action,status=active(lastStatus)?lastStatus:null;if(!status){try{let body=await post("linux-record-replay-status",{},2500);status=statusFrom(body);lastStatus=status;updateHud()}catch{return false}}if(!active(status))return false;let sessionDir=sessionDirFrom(status);if(!sessionDir)return false;let key=sessionDir+"|"+action+"|"+transcript;if(capturedTranscripts.has(key))return true;rememberTranscriptKey(key);try{await post("linux-record-replay-speech-context",{sessionDir,transcript,source:"codex-dictation-"+action},15000);return true}catch{capturedTranscripts.delete(key);return false}}`,
    `async function captureTranscript(text,action){let item=normalizeTranscript(text,action);if(!item)return false;if(await writeTranscript(item))return true;return rememberPendingTranscript(item)}`,
    `async function flushPendingTranscripts(){drainBootstrapTranscriptQueue();if(!pendingTranscripts.length)return false;let queue=pendingTranscripts.splice(0);for(let item of queue){if(Date.now()-item.queuedAt>600000||item.attempts>24)continue;if(!await writeTranscript(item)){item.attempts=(item.attempts||0)+1;rememberPendingTranscript(item)}}return true}`,
    `async function captureDesktopSnapshot(){if(desktopSnapshotInFlight||Date.now()-lastDesktopSnapshotAt<5000)return false;let status=active(lastStatus)?lastStatus:null;if(!status){try{let body=await post("linux-record-replay-status",{},2500);status=statusFrom(body);lastStatus=status;updateHud()}catch{return false}}if(!active(status))return false;let sessionDir=sessionDirFrom(status);if(!sessionDir)return false;desktopSnapshotInFlight=true;lastDesktopSnapshotAt=Date.now();try{await post("linux-record-replay-desktop-snapshot",{sessionDir,source:"record-replay-hud"},15000);return true}catch{lastDesktopSnapshotAt=0;return false}finally{desktopSnapshotInFlight=false}}`,
    `function elapsedText(s){let start=Date.parse(s?.started_at||"");let seconds=Number.isFinite(start)?Math.max(0,Math.floor((Date.now()-start)/1000)):0;let m=Math.floor(seconds/60),r=String(seconds%60).padStart(2,"0");return m+":"+r}`,
    `function updateHud(){let h=ensureHud(),on=active(lastStatus);h.dataset.active=on?"true":"false";if(!on)return;let time=h.querySelector(".codex-linux-record-replay-time");time&&(time.textContent=elapsedText(lastStatus));h.title=lastStatus?.goal?("Recording: "+lastStatus.goal):"Record & Replay recording active";positionHud()}`,
    `async function refresh(){try{let body=await post("linux-record-replay-status",{},2500);lastStatus=statusFrom(body);updateHud()}catch{lastStatus=null;updateHud()}}`,
    `async function stopActive(){try{let body=await post("linux-record-replay-stop-active",{},10000);return !!(body?.ok||body?.json?.ok)}catch{return false}finally{setTimeout(refresh,250)}}`,
    `async function cancelActive(discarded){try{let body=await post("linux-record-replay-cancel-active",{discarded:!!discarded},10000);return !!(body?.ok||body?.json?.ok)}catch{return false}finally{setTimeout(refresh,250)}}`,
    `async function finishRecording(){if(stopping||canceling)return;stopping=true;let btns=hud?.querySelectorAll("button")??[];btns.forEach(b=>b.disabled=true);try{let stopped=await stopActive(),submitted=false;try{submitted=await submitDoneMessage()}catch{}if(!stopped&&!submitted)await stopActive()}finally{stopping=false;btns.forEach(b=>b.disabled=false);setTimeout(refresh,250)}}`,
    `async function discardRecording(){if(stopping||canceling)return;if(!confirm("Discard this Record & Replay recording? The bundle will be kept only as canceled evidence."))return;canceling=true;let btns=hud?.querySelectorAll("button")??[];btns.forEach(b=>b.disabled=true);try{await cancelActive(true)}finally{canceling=false;btns.forEach(b=>b.disabled=false);setTimeout(refresh,250)}}`,
    `async function tick(){updateHud();try{await refresh();await flushPendingTranscripts();await captureDesktopSnapshot()}catch{}}`,
    `function start(){if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start,{once:!0});return}ensureHud();tick();timer=setInterval(tick,1000);window.addEventListener("resize",positionHud);window.addEventListener("scroll",positionHud,true);new MutationObserver(positionHud).observe(document.body||document.documentElement,{childList:true,subtree:true})}`,
    `globalThis.codexLinuxRecordReplayCaptureTranscript=captureTranscript;`,
    `start();`,
    `})();`,
  ].join("");
}

function recordReplayTranscriptCaptureExpression(transcriptVar, actionVar) {
  return `(globalThis.codexLinuxRecordReplayCaptureTranscript?.(${transcriptVar},${actionVar})??((globalThis.codexLinuxRecordReplayPendingTranscripts??=[]).push({transcript:${transcriptVar},action:${actionVar},queuedAt:Date.now()}),!1))`;
}

function recordReplayActiveSpeechContextExpression(dispatchVar, transcriptVar) {
  return `(()=>{let t=String(${transcriptVar}??"").trim();if(t.length>0){let n="codex-linux-record-replay-global-dictation-"+Date.now()+"-"+Math.random().toString(36).slice(2);${dispatchVar}.dispatchMessage("fetch",{hostId:"local",requestId:n,method:"POST",url:"vscode://codex/linux-record-replay-speech-context-active",body:JSON.stringify({transcript:t,source:"codex-global-dictation"})})}})()`;
}

function applyRecordReplayHudPatch(currentSource) {
  if (currentSource.includes("codexLinuxRecordReplayHudVersion=")) {
    return currentSource;
  }
  const separator = currentSource.endsWith("\n") ? "" : "\n";
  return currentSource + separator + recordReplayHudRuntimeSource();
}

function applyRecordReplayDictationTranscriptPatch(currentSource) {
  const patchName = "Record & Replay dictation transcript patch";
  if (currentSource.includes("codexLinuxRecordReplayCaptureTranscript")) {
    return currentSource;
  }
  if (!currentSource.includes("global-dictation-record-history-item")) {
    return currentSource;
  }

  const upstreamNeedle =
    "i.length>0&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))";
  if (currentSource.includes(upstreamNeedle)) {
    return currentSource.replace(
      upstreamNeedle,
      `i.length>0&&(${recordReplayTranscriptCaptureExpression("i", "e")},j.getInstance().dispatchMessage(\`global-dictation-record-history-item\`,{text:i}),e===\`send\`?n.onTranscriptSend(i):n.onTranscriptInsert(i))`,
    );
  }

  const conversationNeedle =
    "i.length>0&&e!==`discard`&&globalThis.codexLinuxConversationShouldSendTranscript?.(i,e)!==!1&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))";
  if (currentSource.includes(conversationNeedle)) {
    return currentSource.replace(
      conversationNeedle,
      `i.length>0&&e!==\`discard\`&&globalThis.codexLinuxConversationShouldSendTranscript?.(i,e)!==!1&&(${recordReplayTranscriptCaptureExpression("i", "e")},j.getInstance().dispatchMessage(\`global-dictation-record-history-item\`,{text:i}),e===\`send\`?n.onTranscriptSend(i):n.onTranscriptInsert(i))`,
    );
  }

  const conversationPattern =
    /([A-Za-z_$][\w$]*)\.length>0&&([A-Za-z_$][\w$]*)!==`discard`&&globalThis\.codexLinuxConversationShouldSendTranscript\?\.\(\1,\2\)!==!1&&\((([A-Za-z_$][\w$]*)\.getInstance\(\)\.dispatchMessage\(`global-dictation-record-history-item`,\{text:\1\}\),\2===`send`\?([A-Za-z_$][\w$]*)\.onTranscriptSend\(\1\):\5\.onTranscriptInsert\(\1\))\)/u;
  if (conversationPattern.test(currentSource)) {
    return currentSource.replace(
      conversationPattern,
      (_, transcriptVar, actionVar, dispatchExpression) =>
        `${transcriptVar}.length>0&&${actionVar}!==\`discard\`&&globalThis.codexLinuxConversationShouldSendTranscript?.(${transcriptVar},${actionVar})!==!1&&(${recordReplayTranscriptCaptureExpression(transcriptVar, actionVar)},${dispatchExpression})`,
    );
  }

  const upstreamPattern =
    /([A-Za-z_$][\w$]*)\.length>0&&\((([A-Za-z_$][\w$]*)\.getInstance\(\)\.dispatchMessage\(`global-dictation-record-history-item`,\{text:\1\}\),([A-Za-z_$][\w$]*)===`send`\?([A-Za-z_$][\w$]*)\.onTranscriptSend\(\1\):\5\.onTranscriptInsert\(\1\))\)/u;
  if (upstreamPattern.test(currentSource)) {
    return currentSource.replace(
      upstreamPattern,
      (_, transcriptVar, dispatchExpression, _historyVar, actionVar) =>
        `${transcriptVar}.length>0&&(${recordReplayTranscriptCaptureExpression(transcriptVar, actionVar)},${dispatchExpression})`,
    );
  }

  warn("Could not find dictation transcript send point", patchName);
  return currentSource;
}

function applyRecordReplayGlobalDictationTranscriptPatch(currentSource) {
  const patchName = "Record & Replay global dictation transcript patch";
  if (currentSource.includes("codex-linux-record-replay-global-dictation")) {
    return currentSource;
  }
  if (!currentSource.includes("global-dictation-completed")) {
    return currentSource;
  }

  const completedPattern =
    /(([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)&&\(\2=null\),)([A-Za-z_$][\w$]*)\.dispatchMessage\(`global-dictation-completed`,\{sessionId:\3\.sessionId,text:([A-Za-z_$][\w$]*)\}\)/u;
  if (completedPattern.test(currentSource)) {
    return currentSource.replace(
      completedPattern,
      (_, prefix, _stateVar, sessionVar, dispatchVar, transcriptVar) =>
        `${prefix}${recordReplayActiveSpeechContextExpression(dispatchVar, transcriptVar)},${dispatchVar}.dispatchMessage(\`global-dictation-completed\`,{sessionId:${sessionVar}.sessionId,text:${transcriptVar}})`,
    );
  }

  warn("Could not find global dictation completion point", patchName);
  return currentSource;
}

const descriptors = [
  {
    id: "record-and-replay-plugin-gate",
    phase: "main-bundle",
    order: 150,
    ciPolicy: "optional",
    apply: applyRecordReplayPluginGatePatch,
  },
  {
    id: "linux-record-replay-main-bridge",
    phase: "main-bundle",
    order: 151,
    apply: applyRecordReplayMainBridgePatch,
  },
  {
    id: "record-replay-hud",
    phase: "webview-asset",
    order: 152,
    ciPolicy: "optional",
    pattern: /^index-.*\.js$/,
    missingDescription: "webview index bundle",
    skipDescription: "Record & Replay HUD runtime patch",
    apply: applyRecordReplayHudPatch,
  },
  {
    id: "record-replay-dictation-transcript",
    phase: "webview-asset",
    order: 20695,
    ciPolicy: "optional",
    pattern:
      /^(?:(?:browser-sidebar-comment-light-dismiss|use-dictation(?!-hotkey))-|app-initial~app-main~.*onboarding-page).*\.js$/,
    missingDescription: "composer dictation bundle",
    skipDescription: "Record & Replay dictation transcript patch",
    apply: applyRecordReplayDictationTranscriptPatch,
  },
  {
    id: "record-replay-global-dictation-transcript",
    phase: "webview-asset",
    order: 20696,
    ciPolicy: "optional",
    pattern: /^global-dictation-.*\.js$/,
    missingDescription: "global dictation bundle",
    skipDescription: "Record & Replay global dictation transcript patch",
    apply: applyRecordReplayGlobalDictationTranscriptPatch,
  },
];

module.exports = {
  RECORD_REPLAY_PLUGIN_NAME,
  HUD_RUNTIME_VERSION,
  applyRecordReplayDictationTranscriptPatch,
  applyRecordReplayGlobalDictationTranscriptPatch,
  applyRecordReplayPluginGatePatch,
  applyRecordReplayHudPatch,
  applyRecordReplayMainBridgePatch,
  descriptors,
  recordReplayChronicleHelperSource,
  recordReplayBridgeSource,
  recordReplayHudRuntimeSource,
  recordReplayHelperSource,
};
