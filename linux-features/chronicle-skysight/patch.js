"use strict";

const CHRONICLE_MODULE_EXPRESSIONS = Object.freeze({
  childProcessVar: 'require("node:child_process")',
  fsVar: 'require("node:fs")',
  pathVar: 'require("node:path")',
});

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function regexMatchCount(source, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))].length;
}

function chronicleSkysightBridgeSource() {
  return [
    `"chronicle-permissions":async()=>{let e=await codexLinuxChronicleSidecarControlStateAsync(),t=e.enabled===!0?"granted":"unknown";return{accessibility:t,screenRecording:t,chronicleSidecarPresent:e.enabled===!0,chronicleSidecarProcessState:e.state??"disabled",chronicleOcrAvailable:e.chronicleOcrAvailable===!0,chronicleOcrStatus:e.chronicleOcrStatus??"unknown",chronicleOcrBackend:e.chronicleOcrBackend??null,chronicleOcrLanguage:e.chronicleOcrLanguage??null}}`,
    `"getChronicleSidecarControlState":async()=>codexLinuxChronicleSidecarControlStateAsync()`,
    `"toggleChronicleSidecar":async()=>codexLinuxChronicleToggleSidecar()`,
    `"linux-record-replay-skysight-start":async({intervalSeconds:e,summaryAgent:t,source:r,owner:a}={})=>{let n=["skysight","start"];e&&n.push("--interval-seconds",String(e));r&&n.push("--source",String(r));a&&n.push("--owner",String(a));t===!0&&n.push("--summary-agent","enabled");t===!1&&n.push("--summary-agent","disabled");return codexLinuxRecordReplayRun(n,15000)}`,
    `"linux-record-replay-skysight-status":async()=>codexLinuxRecordReplayRun(["skysight","status"],5000)`,
    `"linux-record-replay-skysight-pause":async()=>codexLinuxRecordReplayRun(["skysight","pause"],10000)`,
    `"linux-record-replay-skysight-resume":async()=>codexLinuxRecordReplayRun(["skysight","resume"],10000)`,
    `"linux-record-replay-skysight-stop":async()=>codexLinuxRecordReplayRun(["skysight","stop"],10000)`,
    `"linux-record-replay-skysight-snapshot":async({source:e}={})=>{let t=["skysight","snapshot"];e&&t.push("--source",String(e));return codexLinuxRecordReplayRun(t,15000)}`,
    `"linux-record-replay-skysight-list-exclusions":async()=>codexLinuxRecordReplayRun(["skysight","list-exclusions"],5000)`,
    `"linux-record-replay-skysight-update-exclusion":async({kind:e,value:t,reason:n,remove:r}={})=>{let a=codexLinuxRecordReplayString(e),o=codexLinuxRecordReplayString(t);if(!a||!o)return{ok:!1,action:"skysight.update-exclusion",message:"kind and value are required"};let s=["skysight","update-exclusion","--kind",a,"--value",o];n&&s.push("--reason",String(n));r&&s.push("--remove");return codexLinuxRecordReplayRun(s,10000)}`,
  ].join(",");
}

function recordReplayRuntimeHelperSource({ childProcessVar, fsVar, pathVar }) {
  return `function codexLinuxRecordReplayString(e){return typeof e==="string"&&e.trim().length>0?e.trim():null}
function codexLinuxRecordReplayBin(){let e=codexLinuxRecordReplayString(process.env.CODEX_RECORD_REPLAY_LINUX_BIN);if(e)return e;let t=[];try{process.resourcesPath&&t.push(${pathVar}.join(process.resourcesPath,"native","codex-record-replay-linux"))}catch{}try{t.push(${pathVar}.join(process.cwd(),"resources","native","codex-record-replay-linux"))}catch{}try{let e=process.env.PATH||"";for(let n of e.split(${pathVar}.delimiter))n&&t.push(${pathVar}.join(n,"codex-record-replay-linux"))}catch{}t.push("codex-record-replay-linux");for(let e of t){try{if(e==="codex-record-replay-linux"||${fsVar}.existsSync(e))return e}catch{}}return "codex-record-replay-linux"}
function codexLinuxRecordReplayParse(e){let t=String(e||"").trim();if(!t)return null;try{return JSON.parse(t)}catch{return{raw:t}}}
function codexLinuxRecordReplayRun(e,t){let n=codexLinuxRecordReplayBin();return new Promise(r=>{${childProcessVar}.execFile(n,e,{encoding:"utf8",timeout:t,maxBuffer:16777216},(t,a,o)=>{let s=codexLinuxRecordReplayParse(a);if(t)return r({ok:!1,command:n,args:e,message:t instanceof Error?t.message:String(t),code:t?.code??null,stdout:a||"",stderr:o||"",json:s});r({ok:!0,command:n,args:e,stdout:a||"",stderr:o||"",json:s})})})}
${chronicleSkysightHelperSource({ childProcessVar })}`;
}

function chronicleSkysightHelperSource({ childProcessVar }) {
  return `function codexLinuxRecordReplayRunSync(e,t){let n=codexLinuxRecordReplayBin();try{let r=${childProcessVar}.execFileSync(n,e,{encoding:"utf8",timeout:t,maxBuffer:16777216});return{ok:!0,command:n,args:e,stdout:r||"",stderr:"",json:codexLinuxRecordReplayParse(r)}}catch(r){let a=typeof r?.stdout==="string"?r.stdout:r?.stdout?String(r.stdout):"",o=typeof r?.stderr==="string"?r.stderr:r?.stderr?String(r.stderr):"";return{ok:!1,command:n,args:e,message:r instanceof Error?r.message:String(r),code:r?.status??r?.code??null,stdout:a,stderr:o,json:codexLinuxRecordReplayParse(a)}}}
function codexLinuxChronicleControlStateFromSkysight(e){let t=e?.json&&typeof e.json==="object"?e.json:null;if(!e?.ok&&t==null)return{enabled:!1,running:!1,state:"disabled"};let n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused",o=n==="running"&&r&&!a;return{enabled:!0,running:o,state:o?"running":"stopped",skysight:t,chronicleOcrAvailable:t?.ocr_available===!0||t?.ocrAvailable===!0,chronicleOcrStatus:t?.ocr_status??t?.ocrStatus??"unknown",chronicleOcrBackend:t?.ocr_backend??t?.ocrBackend??null,chronicleOcrLanguage:t?.ocr_language??t?.ocrLanguage??null}}
function codexLinuxChronicleSidecarControlState(){return codexLinuxChronicleControlStateFromSkysight(codexLinuxRecordReplayRunSync(["skysight","status"],3000))}
async function codexLinuxChronicleSidecarControlStateAsync(){return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","status"],5000))}
function codexLinuxChronicleSummaryAgentArgs(e){return e===!0?["--summary-agent","enabled"]:e===!1?["--summary-agent","disabled"]:[]}
async function codexLinuxChronicleEnsureSidecarRunning(e,u,l){let t=await codexLinuxRecordReplayRun(["skysight","status"],5000),n=t?.json&&typeof t.json==="object"?t.json:null,r=String(n?.state||""),a=n?.is_running===!0||n?.isRunning===!0,o=n?.paused===!0||n?.is_paused===!0||n?.isPaused===!0||r==="paused",s=codexLinuxChronicleSummaryAgentArgs(e),i=e===!0&&(n?.summary_agent_enabled!==!0&&n?.summaryAgentEnabled!==!0),c=u||l||i;u&&s.push("--source",String(u));l&&s.push("--owner",String(l));if(r==="running"&&a&&!o)return c?codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000)):codexLinuxChronicleControlStateFromSkysight(t);if(a&&o){c&&await codexLinuxRecordReplayRun(["skysight","start",...s],15000);return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","resume"],10000))}return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start",...s],15000))}
async function codexLinuxChronicleToggleSidecar(){let e=await codexLinuxRecordReplayRun(["skysight","status"],5000),t=e?.json&&typeof e.json==="object"?e.json:null,n=String(t?.state||""),r=t?.is_running===!0||t?.isRunning===!0,a=t?.paused===!0||t?.is_paused===!0||t?.isPaused===!0||n==="paused";if(n==="running"&&r&&!a)return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","pause"],10000));if(r&&a)return codexLinuxChronicleEnsureSidecarRunning(!0,"chronicle-tray","manual-continuous");return codexLinuxChronicleControlStateFromSkysight(await codexLinuxRecordReplayRun(["skysight","start","--source","chronicle-tray","--owner","manual-continuous","--summary-agent","enabled"],15000))}`;
}

function chronicleTrayControlPattern() {
  return /getChronicleSidecarControlState:\(\)=>([A-Za-z_$][\w$]*)\(\)\.skysight\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*\.appServerConnectionRegistry\.getMaybeConnection\(`local`\)\?\.getChronicleSidecarControlState\(\)\?\?\2),toggleChronicleSidecar:async\(\)=>\{if\(\1\(\)\.skysight\)return \2;let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\.appServerConnectionRegistry\.getMaybeConnection\([A-Za-z_$][\w$]*\));return \4==null\?\2:\4\.getChronicleSidecarControlState\(\)\.running\?\4\.pauseChronicleSidecar\(\):\4\.resumeChronicleSidecar\(\)\}/u;
}

function chronicleTrayPatchedPattern() {
  return /getChronicleSidecarControlState:\(\)=>process\.platform===`linux`\?codexLinuxChronicleSidecarControlState\(\):([A-Za-z_$][\w$]*)\(\)\.skysight\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*\.appServerConnectionRegistry\.getMaybeConnection\(`local`\)\?\.getChronicleSidecarControlState\(\)\?\?\2),toggleChronicleSidecar:async\(\)=>\{if\(process\.platform===`linux`\)return codexLinuxChronicleToggleSidecar\(\);if\(\1\(\)\.skysight\)return \2;let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*\.appServerConnectionRegistry\.getMaybeConnection\([A-Za-z_$][\w$]*\));return \4==null\?\2:\4\.getChronicleSidecarControlState\(\)\.running\?\4\.pauseChronicleSidecar\(\):\4\.resumeChronicleSidecar\(\)\}/u;
}

function applyChronicleTrayPatch(currentSource) {
  if (chronicleTrayPatchedPattern().test(currentSource)) return currentSource;
  const pattern = chronicleTrayControlPattern();
  if (!pattern.test(currentSource)) {
    warn("Could not find Chronicle tray control callbacks", "Chronicle / Skysight tray bridge patch");
    return currentSource;
  }
  return currentSource.replace(
    pattern,
    (_match, availabilityFunction, disabledStateVar, upstreamStateExpression, connectionVar, connectionExpression) =>
      `getChronicleSidecarControlState:()=>process.platform===\`linux\`?codexLinuxChronicleSidecarControlState():${availabilityFunction}().skysight?${disabledStateVar}:${upstreamStateExpression},toggleChronicleSidecar:async()=>{if(process.platform===\`linux\`)return codexLinuxChronicleToggleSidecar();if(${availabilityFunction}().skysight)return ${disabledStateVar};let ${connectionVar}=${connectionExpression};return ${connectionVar}==null?${disabledStateVar}:${connectionVar}.getChronicleSidecarControlState().running?${connectionVar}.pauseChronicleSidecar():${connectionVar}.resumeChronicleSidecar()}`,
  );
}

function hasCompleteChroniclePatch(source) {
  const helper = recordReplayRuntimeHelperSource(CHRONICLE_MODULE_EXPRESSIONS);
  const bridge = chronicleSkysightBridgeSource();
  return countOccurrences(source, helper) === 1
    && countOccurrences(source, bridge) === 1
    && regexMatchCount(source, chronicleTrayPatchedPattern()) === 1;
}

function applyChronicleSkysightMainBridgePatch(currentSource) {
  const patchName = "Chronicle / Skysight main bridge patch";
  if (currentSource.includes("codexLinuxChronicleControlStateFromSkysight")) {
    if (!hasCompleteChroniclePatch(currentSource)) {
      warn("Found incomplete Chronicle / Skysight bridge patch", patchName);
    }
    return currentSource;
  }
  if (!chronicleTrayControlPattern().test(currentSource)) {
    warn("Could not find Chronicle tray control callbacks", patchName);
    return currentSource;
  }
  const handlerNeedle = `"get-global-state":async({key:`;
  if (!currentSource.includes(handlerNeedle)) {
    warn("Could not find global-state bridge insertion point", patchName);
    return currentSource;
  }
  const helper = recordReplayRuntimeHelperSource(CHRONICLE_MODULE_EXPRESSIONS);
  const bridge = chronicleSkysightBridgeSource();
  const patched = `${helper}\n${currentSource.replace(handlerNeedle, `${bridge},${handlerNeedle}`)}`;
  return applyChronicleTrayPatch(patched);
}

const descriptors = [
  {
    id: "linux-chronicle-skysight-main-bridge",
    phase: "main-bundle",
    order: 151,
    apply: applyChronicleSkysightMainBridgePatch,
  },
];

module.exports = {
  applyChronicleSkysightMainBridgePatch,
  chronicleSkysightBridgeSource,
  chronicleSkysightHelperSource,
  descriptors,
  recordReplayRuntimeHelperSource,
};
