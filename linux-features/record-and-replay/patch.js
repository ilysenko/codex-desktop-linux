"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findMainProcessChunks, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");
const {
  inspectChronicleBridge,
  BRIDGE_HANDLERS_NAME: CHRONICLE_BRIDGE_HANDLERS_NAME,
  BRIDGE_HANDLERS_END_MARKER: CHRONICLE_BRIDGE_HANDLERS_END_MARKER,
} = require("../chronicle-skysight/patch.js");

const { RECORD_REPLAY_PLUGIN_NAME, applyRecordReplayPluginGateToExtractedApp } = require("./plugin-gate.js");
const HUD_RUNTIME_VERSION = 6;
const RECORD_REPLAY_MODULE_EXPRESSIONS = Object.freeze({
  childProcessVar: 'require("node:child_process")',
  fsVar: 'require("node:fs")',
  pathVar: 'require("node:path")',
});

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function recordReplayBridgeSource({ fsVar }) {
  return [
    `"linux-record-replay-doctor":async()=>codexLinuxRecordReplayRun([${JSON.stringify("doctor")}],15000)`,
    `"linux-record-replay-status":async()=>codexLinuxRecordReplayRun([${JSON.stringify("status")}],5000)`,
    `"linux-record-replay-start":async({sessionDir:e,appId:t,windowId:n,goal:r,includeScreenshot:a,includeAccessibility:o,includeAudio:s}={})=>{let i=codexLinuxRecordReplayString(e);if(!i)return{ok:!1,action:"record.start",message:"sessionDir is required"};let c=["record","start","--session-dir",i];t&&c.push("--app-id",String(t));n&&c.push("--window-id",String(n));r&&c.push("--goal",String(r));a===!1&&c.push("--no-screenshot");o===!1&&c.push("--no-accessibility");s===!0&&c.push("--audio");s===!1&&c.push("--no-audio");return codexLinuxRecordReplayRun(c,60000)}`,
    `"linux-record-replay-mark":async({sessionDir:e,note:t}={})=>{let n=codexLinuxRecordReplayString(e),r=codexLinuxRecordReplayString(t);if(!n||!r)return{ok:!1,action:"record.mark",message:"sessionDir and note are required"};return codexLinuxRecordReplayRun(["record","mark","--session-dir",n,"--note",r],15000)}`,
    `"linux-record-replay-speech-context":async({sessionDir:e,transcript:t,source:n}={})=>{let r=codexLinuxRecordReplayString(e),a=codexLinuxRecordReplayString(t);if(!r||!a)return{ok:!1,action:"record.speech",message:"sessionDir and transcript are required"};let o=["record","speech","--session-dir",r,"--text",a];n&&o.push("--source",String(n));return codexLinuxRecordReplayRun(o,15000)}`,
    recordReplayActiveSpeechContextBridgeHandler(),
    `"linux-record-replay-browser-trace":async({sessionDir:e,trace:t,traceJson:n,url:r,title:a,source:o}={})=>{let s=codexLinuxRecordReplayString(e),i=codexLinuxRecordReplayString(n);if(!s)return{ok:!1,action:"record.browser-trace",message:"sessionDir is required"};if(!i&&t!==void 0)i=JSON.stringify(t);if(!i)return{ok:!1,action:"record.browser-trace",message:"trace or traceJson is required"};let c=codexLinuxRecordReplayWriteTempJson(i);try{let l=["record","browser-trace","--session-dir",s,"--trace-file",c];r&&l.push("--url",String(r));a&&l.push("--title",String(a));o&&l.push("--source",String(o));return await codexLinuxRecordReplayRun(l,30000)}finally{try{${fsVar}.unlinkSync(c)}catch{}}}`,
    `"linux-record-replay-desktop-snapshot":async({sessionDir:e,source:t}={})=>{let n=codexLinuxRecordReplayString(e);if(!n)return{ok:!1,action:"record.desktop-snapshot",message:"sessionDir is required"};let r=["record","desktop-snapshot","--session-dir",n];t&&r.push("--source",String(t));return codexLinuxRecordReplayRun(r,15000)}`,
    `"linux-record-replay-stop":async({sessionDir:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"record.stop",message:"sessionDir is required"};return codexLinuxRecordReplayRun(["record","stop","--session-dir",t],15000)}`,
    `"linux-record-replay-stop-active":async()=>{let e=await codexLinuxRecordReplayRun(["status"],5000),t=codexLinuxRecordReplayActiveSessionDir(e);if(t==null)return{ok:!1,action:"record.stop-active",message:"No active Record & Replay session",status:e};return codexLinuxRecordReplayRun(["record","stop","--session-dir",String(t)],15000)}`,
    `"linux-record-replay-cancel":async({sessionDir:e,discarded:t}={})=>{let n=codexLinuxRecordReplayString(e);if(!n)return{ok:!1,action:"record.cancel",message:"sessionDir is required"};let r=["record","cancel","--session-dir",n];t&&r.push("--discarded");return codexLinuxRecordReplayRun(r,15000)}`,
    `"linux-record-replay-cancel-active":async({discarded:e}={})=>{let t=await codexLinuxRecordReplayRun(["status"],5000),n=codexLinuxRecordReplayActiveSessionDir(t);if(n==null)return{ok:!1,action:"record.cancel-active",message:"No active Record & Replay session",status:t};let r=["record","cancel","--session-dir",String(n)];e&&r.push("--discarded");return codexLinuxRecordReplayRun(r,15000)}`,
    `"linux-record-replay-bundle":async({bundle:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"bundle.validate",message:"bundle is required"};return codexLinuxRecordReplayRun(["bundle","validate","--bundle",t],15000)}`,
    `"linux-record-replay-draft-skill":async({bundle:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"bundle.draft-prompt",message:"bundle is required"};return codexLinuxRecordReplayRun(["bundle","draft-prompt","--bundle",t],30000)}`,
    `"linux-record-replay-import-skill":async({source:e,dryRun:t,allowUnsupported:n}={})=>{let r=codexLinuxRecordReplayString(e);if(!r)return{ok:!1,action:"skill.import",message:"source is required"};let a=["skill","import","--source",r];t&&a.push("--dry-run");n&&a.push("--allow-unsupported");return codexLinuxRecordReplayRun(a,30000)}`,
    `"linux-record-replay-inspect-skill":async({source:e}={})=>{let t=codexLinuxRecordReplayString(e);if(!t)return{ok:!1,action:"skill.inspect",message:"source is required"};return codexLinuxRecordReplayRun(["skill","inspect","--source",t],15000)}`,
  ].join(",");
}

function recordReplayActiveSpeechContextBridgeHandler() {
  return `"linux-record-replay-speech-context-active":async({transcript:e,source:t}={})=>{let n=codexLinuxRecordReplayString(e);if(!n)return{ok:!1,action:"record.speech-active",message:"transcript is required"};let r=await codexLinuxRecordReplayRun(["status"],5000),a=codexLinuxRecordReplayActiveSessionDir(r);if(a==null)return{ok:!1,action:"record.speech-active",message:"No active Record & Replay session",status:r};let o=["record","speech","--session-dir",String(a),"--text",n];t&&o.push("--source",String(t));return codexLinuxRecordReplayRun(o,15000)}`;
}

function recordReplayHelperSource({ fsVar, pathVar }) {
  return `function codexLinuxRecordReplayActiveSessionDir(e){let t=e?.json;return e?.ok===!0&&t!=null&&typeof t==="object"&&!Array.isArray(t)&&t.ok===!0&&t.state==="active"&&typeof t.session_dir==="string"&&t.session_dir.trim().length>0?t.session_dir:null}\nfunction codexLinuxRecordReplayWriteTempJson(e){let t=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||"/tmp",n=${pathVar}.join(t,"codex-record-replay-traces-"+(process.getuid?process.getuid():process.pid));${fsVar}.mkdirSync(n,{recursive:true,mode:448});try{if(${fsVar}.lstatSync(n).isSymbolicLink())throw Error("trace directory is a symlink");${fsVar}.chmodSync(n,448)}catch(r){throw r}let r=${pathVar}.join(n,"trace-"+Date.now()+"-"+process.pid+"-"+Math.random().toString(36).slice(2)+".json");let a=${fsVar}.openSync(r,"wx",384);try{${fsVar}.writeFileSync(a,String(e));${fsVar}.closeSync(a);return r}catch(e){try{${fsVar}.closeSync(a)}catch{}try{${fsVar}.unlinkSync(r)}catch{}throw e}}`;
}

// Chronicle owns the real outer registry and native wrapper route. Its complete
// inspection is the authority for both the insertion slot and applied state.
const RECORD_REPLAY_BRIDGE_END_MARKER = "/*codex-linux-record-replay-bridge-end*/";
const RECORD_REPLAY_HELPERS = ["codexLinuxRecordReplayActiveSessionDir", "codexLinuxRecordReplayWriteTempJson"];

function recordReplayMainBridgeRegistration() {
  return `\n${recordReplayHelperSource(RECORD_REPLAY_MODULE_EXPRESSIONS)}\nObject.assign(${CHRONICLE_BRIDGE_HANDLERS_NAME},{${recordReplayBridgeSource(RECORD_REPLAY_MODULE_EXPRESSIONS)}});${RECORD_REPLAY_BRIDGE_END_MARKER}`;
}

function codeAt(source, index) {
  return findMatchingBrace("{" + source.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}
function rootAt(source, index) {
  return findMatchingBrace("{" + source.slice(0, index) + "}", 0) === index + 1;
}
function ownBinding(source, name) {
  try { new Script(`async function probe(){${source}\n;let ${name};}`); return false; }
  catch { return true; }
}
function hasEscapedReservedIdentifier(source, names = [...RECORD_REPLAY_HELPERS, "Date", "Math"]) {
  const reserved = new Set(names);
  for (const token of source.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu)) {
    if (!token[0].includes("\\u")) continue;
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (reserved.has(decoded) && codeAt(source, token.index)) return true;
  }
  return false;
}
function unsafeTempIntrinsic(source, name) {
  if (ownBinding(source, name)) return true;
  const writes = new RegExp(`(?<![\\w$.])(?:${name}\\s*(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))|(?:\\+\\+|--)${name}\\b)`, "gu");
  if ([...source.matchAll(writes)].some(match => codeAt(source, match.index))) return true;
  // A literal expression can replace a read, but cannot replace an assignment
  // target. Probe only potential pattern leaves; ordinary Date.now/Math.random
  // reads never need an extra whole-bundle parse. The second form allows an
  // object-literal shorthand read while still rejecting a shorthand target.
  for (const match of source.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "gu"))) {
    const end = match.index + name.length;
    if (!/^\s*(?:[,}\]]|of\b|in\b)/u.test(source.slice(end)) || !codeAt(source, match.index)) continue;
    const parses = replacement => { try { new Script(source.slice(0, match.index) + replacement + source.slice(end)); return true; } catch { return false; } };
    if (!parses("(0)") && !parses(`${name}:(0)`)) return true;
  }
  return false;
}

function hasAnyRecordReplayMainBridgeArtifact(source) {
  return RECORD_REPLAY_HELPERS.some(name => source.includes(name))
    || hasEscapedReservedIdentifier(source, RECORD_REPLAY_HELPERS)
    || source.includes(RECORD_REPLAY_BRIDGE_END_MARKER)
    || [...recordReplayBridgeSource(RECORD_REPLAY_MODULE_EXPRESSIONS).matchAll(/"([^"]+)":async/gu)]
      .some(match => source.includes(match[1]));
}

function inspectRecordReplayMainBridge(source) {
  const drifted = reason => ({ state: "drifted", reason });
  if (typeof source !== "string") return drifted("Expected source text");
  try {
    const dependency = inspectChronicleBridge(source);
    if (dependency.state !== "patched" || countOccurrences(source, CHRONICLE_BRIDGE_HANDLERS_END_MARKER) !== 1) return drifted("Chronicle / Skysight dependency bridge is missing");
    if (hasEscapedReservedIdentifier(source) || ["Date", "Math"].some(name => unsafeTempIntrinsic(source, name))) return drifted("Shadowed Record & Replay temp-file intrinsic");
    if (!hasAnyRecordReplayMainBridgeArtifact(source)) return { state: "current", dependency, graph: dependency.graph };
    const registration = recordReplayMainBridgeRegistration(), start = dependency.registry.extensionAt, end = start + registration.length;
    if (source.slice(start, end) !== registration || countOccurrences(source, registration) !== 1 || countOccurrences(source, RECORD_REPLAY_BRIDGE_END_MARKER) !== 1) return drifted("Incomplete Record & Replay main bridge patch");
    const callStart = start + registration.indexOf("Object.assign("), callEnd = end - RECORD_REPLAY_BRIDGE_END_MARKER.length;
    const methods = [...recordReplayBridgeSource(RECORD_REPLAY_MODULE_EXPRESSIONS).matchAll(/"([^"]+)":async/gu)].map(match => match[1]);
    const extension = dependency.registry.extensions.find(entry => entry.start === callStart && entry.end === callEnd);
    if (!extension || JSON.stringify(extension.methods) !== JSON.stringify(methods)) return drifted("Record & Replay registry extension has no authority");
    for (const name of RECORD_REPLAY_HELPERS) {
      const references = [...source.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "gu"))].filter(match => codeAt(source, match.index));
      if (references.some(match => match.index < start || match.index >= end)) return drifted("Reserved Record & Replay helper reference outside registration");
      const declaration = source.indexOf(`function ${name}(`, start);
      if (declaration < start || declaration >= end || !rootAt(source, declaration)) return drifted("Record & Replay helper is not an outer declaration");
    }
    return { state: "patched", dependency, graph: dependency.graph, registration: { start, end }, extension };
  } catch { return drifted("Invalid Record & Replay source structure"); }
}

function applyRecordReplayMainBridgePatch(currentSource) {
  const inspection = inspectRecordReplayMainBridge(currentSource);
  if (inspection.state === "patched") return currentSource;
  if (inspection.state !== "current") {
    warn(inspection.reason, "Record & Replay main bridge patch");
    return currentSource;
  }
  const at = inspection.dependency.registry.extensionAt;
  const patched = currentSource.slice(0, at) + recordReplayMainBridgeRegistration() + currentSource.slice(at);
  if (inspectRecordReplayMainBridge(patched).state !== "patched") {
    warn("Record & Replay bridge registration changed while patching", "Record & Replay main bridge patch");
    return currentSource;
  }
  return patched;
}

function applyRecordReplayToExtractedApp(extractedDir) {
  const reject = reason => {
    warn(reason, "Record & Replay main bridge patch");
    return { matched: 0, changed: 0, changedAssets: [], reason };
  };
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) return reject("Missing main-process inventory");
  const records = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8");
    return { assetName, source, graph: inspectMainRequestSites(source) };
  });
  const owners = records.filter(record => record.graph.ok);
  if (owners.length !== 1) return reject("Missing or ambiguous native request owner cohort");
  const owner = owners[0], identity = owner.graph.scope?.factoryId;
  if (identity == null) return reject("Native request factory identity is unavailable");
  const cohort = records.filter(record => record.graph.factoryIds?.includes(identity)
    || hasAnyRecordReplayMainBridgeArtifact(record.source)
    || record.source.includes("codexLinuxChronicle")
    || record.source.includes("codexLinuxRecordReplay")
    || record.source.includes(CHRONICLE_BRIDGE_HANDLERS_END_MARKER));
  if (cohort.length !== 1 || cohort[0] !== owner) return reject("Duplicate, partial or mixed Record & Replay owner cohort");
  const inspection = inspectRecordReplayMainBridge(owner.source);
  if (inspection.state === "drifted") return reject(inspection.reason);
  if (inspection.state === "patched") return { matched: 1, changed: 0, changedAssets: [] };
  const patchedSource = applyRecordReplayMainBridgePatch(owner.source);
  if (inspectRecordReplayMainBridge(patchedSource).state !== "patched") return reject("Record & Replay bridge poststate is incomplete");
  return { matched: 1, ...patchWebviewAssets(inventory.buildDir, [{ assetName: owner.assetName, source: owner.source, patchedSource }]) };
}

function recordReplayHudRuntimeSource() {
  return [
    `;(()=>{`,
    `const VERSION=${HUD_RUNTIME_VERSION};`,
    // rspack appends this runtime to every webview runtime entry; the HUD
    // belongs to the main window only, not to detached popout windows.
    `if(/^\\/detached-window(?:\\.html)?(?:\\/|$)/.test(globalThis.location?.pathname??""))return;`,
    `if(globalThis.codexLinuxRecordReplayHudVersion===VERSION)return;`,
    `globalThis.codexLinuxRecordReplayHudVersion=VERSION;`,
    `let seq=0,pending=new Map,hud=null,timer=null,lastStatus=null,stopping=false,canceling=false,capturedTranscripts=new Set,pendingTranscripts=[],desktopSnapshotInFlight=false,lastDesktopSnapshotAt=0,disposed=false,started=false,observer=null,ownedStyle=null,ownedTimers=new Set,ownedWaits=new Map;`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!=="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);clearTimeout(n.timer);ownedTimers.delete(n.timer);if(t.responseType==="success"){let e=null;try{e=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve(e)}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,event=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){event.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(event)}`,
    `function post(method,params,timeoutMs=4000){if(disposed)return Promise.reject(Error("HUD disposed"));let requestId="codex-linux-record-replay-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+method,body:JSON.stringify(params??{})};return new Promise((resolve,reject)=>{let timer=later(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);pending.set(requestId,{resolve,reject,timer});dispatch(payload)})}`,
    `function later(callback,delay){if(disposed)return null;let handle=setTimeout(()=>{ownedTimers.delete(handle);ownedWaits.delete(handle);if(!disposed)callback()},delay);ownedTimers.add(handle);return handle}`,
    `function wait(delay){return new Promise(resolve=>{if(disposed)return resolve();let handle=later(resolve,delay);ownedWaits.set(handle,resolve)})}`,
    `function retireHud(){if(!hud)return;hud.querySelector(".codex-linux-record-replay-finish")?.removeEventListener("click",finishRecording);hud.querySelector(".codex-linux-record-replay-discard")?.removeEventListener("click",discardRecording);hud.remove();hud=null}`,
    `function updateControls(){hud?.querySelectorAll("button").forEach(button=>button.disabled=stopping||canceling)}`,
    `function cleanup(){if(disposed)return;disposed=true;clearInterval(timer);timer=null;document.removeEventListener("DOMContentLoaded",start);window.removeEventListener("message",onMessage);window.removeEventListener("resize",positionHud);window.removeEventListener("scroll",positionHud,true);window.removeEventListener("pagehide",cleanup);observer?.disconnect();observer=null;for(let handle of ownedTimers)clearTimeout(handle);ownedTimers.clear();for(let resolve of ownedWaits.values())resolve();ownedWaits.clear();for(let request of pending.values())request.reject(Error("HUD disposed"));pending.clear();retireHud();ownedStyle?.remove();ownedStyle=null;if(globalThis.codexLinuxRecordReplayCaptureTranscript===captureTranscript){delete globalThis.codexLinuxRecordReplayCaptureTranscript;if(globalThis.codexLinuxRecordReplayHudVersion===VERSION)delete globalThis.codexLinuxRecordReplayHudVersion}}`,
    `function installStyle(){if(document.getElementById("codex-linux-record-replay-hud-style"))return;let s=document.createElement("style");s.id="codex-linux-record-replay-hud-style";s.textContent=".codex-linux-record-replay-hud{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483002;height:42px;min-width:166px;display:none;align-items:center;gap:10px;padding:0 8px 0 12px;border-radius:14px;background:rgba(49,49,52,.94);border:1px solid rgba(255,255,255,.08);box-shadow:0 14px 34px rgba(0,0,0,.26);color:#f4f4f5;font:600 12px/1 ui-sans-serif,-apple-system,BlinkMacSystemFont,\\"Segoe UI\\",sans-serif;pointer-events:auto;-webkit-app-region:no-drag;backdrop-filter:blur(16px)}.codex-linux-record-replay-hud[data-active=\\"true\\"]{display:flex}.codex-linux-record-replay-dot{width:14px;height:14px;border-radius:999px;border:2px solid rgba(239,82,72,.62);position:relative;box-sizing:border-box}.codex-linux-record-replay-dot::after{content:\\"\\";position:absolute;inset:2px;border-radius:999px;background:#ef4444}.codex-linux-record-replay-time{min-width:29px;color:#ef4444;font-variant-numeric:tabular-nums}.codex-linux-record-replay-btn{width:28px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:0;border-left:1px solid rgba(255,255,255,.08);border-radius:0;background:transparent;color:#d4d4d8;cursor:pointer}.codex-linux-record-replay-btn:hover{color:#fff;background:rgba(255,255,255,.06);border-radius:8px}.codex-linux-record-replay-btn:disabled{opacity:.6;cursor:default}.codex-linux-record-replay-btn svg{width:16px;height:16px}.codex-linux-record-replay-grip{width:18px;height:30px;display:inline-flex;align-items:center;justify-content:center;border-left:1px solid rgba(255,255,255,.08);color:#a1a1aa}.codex-linux-record-replay-grip::before{content:\\"\\";width:3px;height:18px;border-radius:999px;background:linear-gradient(to bottom,#a1a1aa 0 2px,transparent 2px 5px,#a1a1aa 5px 7px,transparent 7px 10px,#a1a1aa 10px 12px,transparent 12px 15px,#a1a1aa 15px 17px)}";document.head?.appendChild?.(s);ownedStyle=s}`,
    `function ensureHud(){if(disposed)return null;if(hud&&document.contains(hud))return hud;retireHud();installStyle();let root=document.createElement("div");root.id="codex-linux-record-replay-hud";root.className="codex-linux-record-replay-hud";root.setAttribute("role","status");root.setAttribute("aria-live","polite");root.innerHTML='<span class="codex-linux-record-replay-dot" aria-hidden="true"></span><span class="codex-linux-record-replay-time">0:00</span><button type="button" class="codex-linux-record-replay-btn codex-linux-record-replay-finish" title="Finish recording" aria-label="Finish Record & Replay recording"><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"></rect></svg></button><button type="button" class="codex-linux-record-replay-btn codex-linux-record-replay-discard" title="Discard recording" aria-label="Discard Record & Replay recording"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M5 6l1 15h12l1-15"></path></svg></button><span class="codex-linux-record-replay-grip" aria-hidden="true"></span>';root.querySelector(".codex-linux-record-replay-finish")?.addEventListener("click",finishRecording);root.querySelector(".codex-linux-record-replay-discard")?.addEventListener("click",discardRecording);(document.body||document.documentElement).appendChild(root);hud=root;updateControls();if(observer){observer.disconnect();observer.observe(document.body||document.documentElement,{childList:true,subtree:true})}return root}`,
    `function findComposer(){let anchors=document.querySelectorAll?.("[data-composer-attachments-row],textarea,[contenteditable='true'],[data-above-composer-portal],[data-above-composer-queue-portal]")??[];for(let i=anchors.length-1;i>=0;i--){let a=anchors[i],t=a.closest?.("form,[data-composer-overlay-floating-ui],[class*='composer']")||a.parentElement;if(t&&document.body?.contains?.(t)&&t.getBoundingClientRect)return t}return null}`,
    `function findComposerEditor(root){let scope=root||document;let candidates=scope.querySelectorAll?.("textarea,[contenteditable='true'],[role='textbox']")??[];for(let i=candidates.length-1;i>=0;i--){let e=candidates[i],rect=e.getBoundingClientRect?.();if(e&&!e.disabled&&(!rect||rect.width>0&&rect.height>0))return e}return null}`,
    `function setNativeValue(el,value){let proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLInputElement?HTMLInputElement.prototype:null,desc=proto?Object.getOwnPropertyDescriptor(proto,"value"):null;if(desc?.set)desc.set.call(el,value);else el.value=value;el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}));el.dispatchEvent(new Event("change",{bubbles:true}))}`,
    `function setEditorText(el,value){el.focus?.();if(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement){setNativeValue(el,value);return true}if(el.isContentEditable||el.getAttribute?.("role")==="textbox"){try{document.execCommand?.("selectAll",false,null);document.execCommand?.("insertText",false,value)}catch{el.textContent=value;el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:value}))}return true}return false}`,
    `function findSendButton(root){let scope=root||document,candidates=[...scope.querySelectorAll?.("button,[role='button']")??[]];for(let i=candidates.length-1;i>=0;i--){let b=candidates[i],label=(b.getAttribute?.("aria-label")||b.title||b.textContent||"").trim().toLowerCase();if(b.disabled||b.getAttribute?.("aria-disabled")==="true")continue;if(/\\b(send|submit|resume)\\b/.test(label))return b}let form=root?.closest?.("form")||root?.querySelector?.("form");let submit=form?.querySelector?.("button[type='submit']:not([disabled])");return submit||null}`,
    `async function submitDoneMessage(){if(disposed)return false;let composer=findComposer(),editor=findComposerEditor(composer)||findComposerEditor(document);if(!editor)return false;let text="I'm done recording.";if(!setEditorText(editor,text))return false;await wait(120);if(disposed)return false;let button=findSendButton(composer)||findSendButton(document);if(button){button.click();return true}let eventInit={key:"Enter",code:"Enter",which:13,keyCode:13,bubbles:true,cancelable:true};editor.dispatchEvent(new KeyboardEvent("keydown",eventInit));editor.dispatchEvent(new KeyboardEvent("keyup",eventInit));return true}`,
    `function resetHudPosition(){if(!hud)return;hud.style.left="50%";hud.style.bottom="96px";hud.style.transform="translateX(-50%)"}`,
    `function positionHud(){if(disposed||!hud||hud.dataset.active!=="true")return;resetHudPosition();let target=findComposer();if(!target)return;let rect=target.getBoundingClientRect(),width=window.innerWidth||document.documentElement?.clientWidth||0,height=window.innerHeight||document.documentElement?.clientHeight||0;if(!width||!height||rect.width<160||rect.height<24||rect.top<0||rect.top>height)return;let left=Math.max(90,Math.min(width-90,rect.left+rect.width/2)),bottom=Math.max(72,Math.min(260,height-rect.top+8));hud.style.left=left+"px";hud.style.bottom=bottom+"px"}`,
    `function statusFrom(body){let s=body?.json?.state?body.json:body?.state?body:null;return s&&typeof s==="object"?s:null}`,
    `function active(s){if(!s||s.state!=="active")return false;if(s.expires_at&&Date.now()>Date.parse(s.expires_at))return false;return true}`,
    `function sessionDirFrom(s){return s?.session_dir||s?.sessionDirectoryPath||s?.runtimeStatus?.session_dir||null}`,
    `function compactTranscript(e){return String(e||"").replace(/\\s+/g," ").trim()}`,
    `function rememberTranscriptKey(e){capturedTranscripts.add(e);if(capturedTranscripts.size>120)capturedTranscripts.delete(capturedTranscripts.values().next().value)}`,
    `function normalizeTranscript(text,action){let transcript=compactTranscript(text);if(!transcript||action==="discard")return null;return{transcript,action:String(action||"unknown"),queuedAt:Date.now(),attempts:0}}`,
    `function rememberPendingTranscript(item){if(disposed)return false;pendingTranscripts.push(item);if(pendingTranscripts.length>60)pendingTranscripts.shift();return true}`,
    `function drainBootstrapTranscriptQueue(){let q=globalThis.codexLinuxRecordReplayPendingTranscripts;if(!Array.isArray(q)||q.length===0)return;globalThis.codexLinuxRecordReplayPendingTranscripts=[];for(let entry of q){let transcript=typeof entry==="string"?entry:entry?.transcript,action=typeof entry==="object"?entry.action:"unknown",queuedAt=typeof entry==="object"&&Number.isFinite(entry.queuedAt)?entry.queuedAt:Date.now(),item=normalizeTranscript(transcript,action);item&&(item.queuedAt=queuedAt,rememberPendingTranscript(item))}}`,
    `async function writeTranscript(item){let transcript=item.transcript,action=item.action,status=active(lastStatus)?lastStatus:null;if(!status){try{let body=await post("linux-record-replay-status",{},2500);status=statusFrom(body);lastStatus=status;updateHud()}catch{return false}}if(disposed||!active(status))return false;let sessionDir=sessionDirFrom(status);if(!sessionDir)return false;let key=sessionDir+"|"+action+"|"+transcript;if(capturedTranscripts.has(key))return true;rememberTranscriptKey(key);try{await post("linux-record-replay-speech-context",{sessionDir,transcript,source:"codex-dictation-"+action},15000);return true}catch{capturedTranscripts.delete(key);return false}}`,
    `async function captureTranscript(text,action){if(disposed)return false;let item=normalizeTranscript(text,action);if(!item)return false;if(await writeTranscript(item))return true;return rememberPendingTranscript(item)}`,
    `async function flushPendingTranscripts(){if(disposed)return false;drainBootstrapTranscriptQueue();if(!pendingTranscripts.length)return false;let queue=pendingTranscripts.splice(0);for(let item of queue){if(Date.now()-item.queuedAt>600000||item.attempts>24)continue;if(!await writeTranscript(item)){item.attempts=(item.attempts||0)+1;rememberPendingTranscript(item)}}return true}`,
    `async function captureDesktopSnapshot(){if(disposed||desktopSnapshotInFlight||Date.now()-lastDesktopSnapshotAt<5000)return false;desktopSnapshotInFlight=true;try{let status=active(lastStatus)?lastStatus:null;if(!status){let body=await post("linux-record-replay-status",{},2500);status=statusFrom(body);lastStatus=status;updateHud()}if(disposed||!active(status))return false;let sessionDir=sessionDirFrom(status);if(!sessionDir)return false;lastDesktopSnapshotAt=Date.now();await post("linux-record-replay-desktop-snapshot",{sessionDir,source:"record-replay-hud"},15000);return true}catch{lastDesktopSnapshotAt=0;return false}finally{desktopSnapshotInFlight=false}}`,
    `function elapsedText(s){let start=Date.parse(s?.started_at||"");let seconds=Number.isFinite(start)?Math.max(0,Math.floor((Date.now()-start)/1000)):0;let m=Math.floor(seconds/60),r=String(seconds%60).padStart(2,"0");return m+":"+r}`,
    `function updateHud(){if(disposed)return;let h=ensureHud(),on=active(lastStatus);h.dataset.active=on?"true":"false";if(!on)return;let time=h.querySelector(".codex-linux-record-replay-time");time&&(time.textContent=elapsedText(lastStatus));h.title=lastStatus?.goal?("Recording: "+lastStatus.goal):"Record & Replay recording active";positionHud()}`,
    `async function refresh(){if(disposed)return;try{let body=await post("linux-record-replay-status",{},2500);lastStatus=statusFrom(body);updateHud()}catch{lastStatus=null;updateHud()}}`,
    `async function stopActive(){try{let body=await post("linux-record-replay-stop-active",{},10000);return !!(body?.ok||body?.json?.ok)}catch{return false}finally{later(refresh,250)}}`,
    `async function cancelActive(discarded){try{let body=await post("linux-record-replay-cancel-active",{discarded:!!discarded},10000);return !!(body?.ok||body?.json?.ok)}catch{return false}finally{later(refresh,250)}}`,
    `async function finishRecording(){if(disposed||stopping||canceling)return;stopping=true;let btns=hud?.querySelectorAll("button")??[];btns.forEach(b=>b.disabled=true);try{let stopped=await stopActive(),submitted=false;if(disposed)return;try{submitted=await submitDoneMessage()}catch{}if(!stopped&&!submitted)await stopActive()}finally{stopping=false;btns.forEach(b=>b.disabled=false);updateControls();later(refresh,250)}}`,
    `async function discardRecording(){if(disposed||stopping||canceling)return;if(!confirm("Discard this Record & Replay recording? The bundle will be kept only as canceled evidence."))return;canceling=true;let btns=hud?.querySelectorAll("button")??[];btns.forEach(b=>b.disabled=true);try{await cancelActive(true)}finally{canceling=false;btns.forEach(b=>b.disabled=false);updateControls();later(refresh,250)}}`,
    `async function tick(){if(disposed)return;updateHud();try{await refresh();await flushPendingTranscripts();await captureDesktopSnapshot()}catch{}}`,
    `function start(){if(disposed||started)return;if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start,{once:!0});return}started=true;ensureHud();tick();timer=setInterval(tick,1000);window.addEventListener("resize",positionHud);window.addEventListener("scroll",positionHud,true);observer=new MutationObserver(positionHud);observer.observe(document.body||document.documentElement,{childList:true,subtree:true})}`,
    `globalThis.codexLinuxRecordReplayCaptureTranscript=captureTranscript;window.addEventListener("pagehide",cleanup,{once:true});`,
    `start();`,
    `})();`,
  ].join("");
}

function recordReplayTranscriptCaptureExpression(transcriptVar, actionVar) {
  return `(()=>{try{let codexLinuxRecordReplayCaptureResult=(globalThis.codexLinuxRecordReplayCaptureTranscript?.(${transcriptVar},${actionVar})??((globalThis.codexLinuxRecordReplayPendingTranscripts??=[]).push({transcript:${transcriptVar},action:${actionVar},queuedAt:Date.now()}),!1));codexLinuxRecordReplayCaptureResult?.catch?.(()=>{});return codexLinuxRecordReplayCaptureResult}catch{return!1}})()`;
}

function recordReplayActiveSpeechContextExpression(dispatchVar, transcriptVar) {
  return `(()=>{let t=String(${transcriptVar}??"").trim();if(t.length>0){let n="codex-linux-record-replay-global-dictation-"+Date.now()+"-"+Math.random().toString(36).slice(2);${dispatchVar}.dispatchMessage("fetch",{hostId:"local",requestId:n,method:"POST",url:"vscode://codex/linux-record-replay-speech-context-active",body:JSON.stringify({transcript:t,source:"codex-global-dictation"})})}})()`;
}


const DICTATION_IDENTIFIER = "[A-Za-z_$][\\w$]*";
const DICTATION_PUBLIC_API = "codexLinuxRecordReplayCaptureTranscript";
const DICTATION_QUEUE = "codexLinuxRecordReplayPendingTranscripts";

function dictationMatches(source, pattern, root = false) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(pattern)].filter(match => lexical.isCode(match.index) && (!root || lexical.isRoot(match.index)));
}

function dictationOne(rows, label) {
  if (rows.length !== 1) throw Error(`${label} matched ${rows.length} times`);
  return rows[0];
}

function dictationDelimiter(source, open) {
  const lexical = createJavaScriptLexicalIndex(source), stack = [], pairs = { "(": ")", "[": "]", "{": "}" };
  if (!pairs[source[open]]) return -1;
  for (let index = open; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (pairs[source[index]]) stack.push(pairs[source[index]]);
    else if (")]}".includes(source[index])) {
      if (stack.pop() !== source[index]) return -1;
      if (!stack.length) return index;
    }
  }
  return -1;
}

function dictationPublicationKeys(module) {
  const body = module.moduleSource, req = escapeRegExp(module.params[2] ?? "");
  const target = escapeRegExp(module.params[1] ?? "");
  const call = dictationOne(dictationMatches(body, new RegExp(`(?<![\\w$.])${req}\\.d\\(${target},\\{`, "gu"), true), "native dictation publication call");
  const maps = [];
  let open = call.index + call[0].length - 1, close = findMatchingBrace(body, open);
  if (close < open) throw Error("Incomplete native dictation publication");
  maps.push(body.slice(open + 1, close));
  if (body.slice(close + 1).startsWith(",{")) {
    open = close + 2; close = findMatchingBrace(body, open);
    if (close < open) throw Error("Incomplete native dictation value publication");
    maps.push(body.slice(open + 1, close));
  }
  const keys = [];
  for (const map of maps) {
    const lexical = createJavaScriptLexicalIndex(map);
    for (const match of map.matchAll(/(?:^|,)("(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*):/gu)) {
      const at = match.index + (match[0].startsWith(",") ? 1 : 0);
      if (lexical.isRoot(at)) keys.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1]);
    }
  }
  return [...new Set(keys)];
}

// The projection changes only a verified declaration leaf and exports target.
// Original subsequent uses stay visible to the shared publication proof.
function dictationBindingProbe(module, name, declarationStart, exportName) {
  const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
  const publication = findRspackExportPublication(module, exportName), body = module.moduleSource;
  if (publication?.expression == null || module.params.includes(name)) throw Error("Unsupported dictation readonly binding");
  const call = dictationOne(dictationMatches(body, new RegExp(`(?<![\\w$.])${escapeRegExp(publication.requireName)}\\.d\\(${escapeRegExp(publication.exportsName)},\\{`, "gu"), true), "dictation binding publication target");
  const exportsStart = call.index + call[0].indexOf("(") + 1;
  if (declarationStart < 0 || body.slice(declarationStart, declarationStart + name.length) !== name) throw Error("Dictation binding preimage changed");
  let probeName = "__codexRecordReplayDictationBindingProbe";
  while (body.includes(probeName)) probeName += "$";
  const edits = [
    { start: declarationStart, end: declarationStart + name.length, before: name, after: probeName },
    { start: exportsStart, end: exportsStart + publication.exportsName.length, before: publication.exportsName, after: name },
  ].sort((left, right) => right.start - left.start);
  if (edits[1].end > edits[0].start) throw Error("Dictation binding proof ranges overlap");
  let projected = body;
  for (const edit of edits) {
    if (body.slice(edit.start, edit.end) !== edit.before) throw Error("Dictation binding proof preimage changed");
    projected = projected.slice(0, edit.start) + edit.after + projected.slice(edit.end);
  }
  const result = findRspackExportPublication({ moduleSource: projected, params: [module.params[0], name, module.params[2]] }, exportName);
  if (result?.exportsName !== name || result.requireName !== publication.requireName || result.expression !== publication.expression) throw Error("Dictation binding is reassigned or redeclared");
  return { edits, projected, result };
}

function dictationRootFunction(module, point) {
  const heads = dictationMatches(module.moduleSource, new RegExp(`\\bfunction (${DICTATION_IDENTIFIER})\\(([^()]*)\\)\\{`, "gu"), true);
  const functions = heads.map(head => {
    const open = head.index + head[0].length - 1, end = findMatchingBrace(module.moduleSource, open);
    return { name: head[1], params: head[2], start: head.index, nameStart: head.index + "function ".length, open, end };
  }).filter(fn => fn.open < point && point < fn.end);
  const fn = dictationOne(functions, "native published dictation hook");
  const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
  const publications = dictationPublicationKeys(module).map(key => ({ key, value: findRspackExportPublication(module, key) })).filter(row => row.value?.expression === fn.name);
  const publication = dictationOne(publications, "native dictation hook publication");
  dictationBindingProbe(module, fn.name, fn.nameStart, publication.key);
  return { ...fn, exportName: publication.key, publication: publication.value };
}

function dictationNativeBody(body, transcript, context) {
  const trivia = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$))*/u.exec(body)[0];
  body = body.slice(trivia.length);
  const id = DICTATION_IDENTIFIER, text = escapeRegExp(transcript), extra = escapeRegExp(context);
  const pattern = [
    `^${text}\\.length>0&&null==(?<history>${id})&&null==(?<handlers>${id})\\.chatgpt\\?(?<dispatcher>${id})\\.(?<dispatchExport>${id})\\.getInstance\\(\\)\\.dispatchMessage\\("global-dictation-record-history-item",\\{text:${text}\\}\\):\\k<history>\\?\\.setTranscript\\(${text},void 0\\),(?<analytics>${id})\\.performance\\.mark\\("transcript_dispatched"\\);let (?<session>${id})=\\k<history>\\?\\.id;`,
    `if\\((?<delivered>${id})=!0,null!=(?<action>${id})\\.recovery&&null!=\\k<handlers>\\.onRecoveryChange\\)\\{if\\((?<recover>${id})\\("recovered",${text},${extra}\\),(?<retrying>${id})&&(?<mounted>${id})\\.current&&(?<generation>${id})===(?<currentGeneration>${id})\\.current\\)\\{let (?<promise>${id})=null==${extra}\\?\\k<handlers>\\.onTranscriptRetry\\?\\.\\(${text},\\k<session>\\):\\k<handlers>\\.onTranscriptRetry\\?\\.\\(${text},\\k<session>,${extra}\\);null==\\k<handlers>\\.chatgpt\\|\\|(?<attached>${id})\\|\\|(?<state>${id})\\(\\k<analytics>,\\{\\.\\.\\.(?<metadata>${id}),action:null==\\k<handlers>\\.onTranscriptRetry\\?\\k<metadata>\\.action:"insert"\\}\\),await \\k<promise>,(?<usedRetry>${id})=null!=\\k<handlers>\\.onTranscriptRetry\\}\\}`,
    `else if\\("send"===\\k<action>\\.action\\)\\{let \\k<promise>=null==${extra}\\?\\k<handlers>\\.onTranscriptSend\\(${text},\\k<session>\\):\\k<handlers>\\.onTranscriptSend\\(${text},\\k<session>,${extra}\\);null==\\k<handlers>\\.chatgpt\\|\\|\\k<attached>\\|\\|\\k<state>\\(\\k<analytics>,\\k<metadata>\\),await \\k<promise>\\}`,
    `else\\{let \\k<promise>=null==${extra}\\?\\k<handlers>\\.onTranscriptInsert\\(${text},\\k<session>\\):\\k<handlers>\\.onTranscriptInsert\\(${text},\\k<session>,${extra}\\);null==\\k<handlers>\\.chatgpt\\|\\|\\k<attached>\\|\\|\\k<state>\\(\\k<analytics>,\\k<metadata>\\),await \\k<promise>,(?<pendingAction>${id})\\.current===\\k<action>&&"send"===\\k<pendingAction>\\.current\\.action&&await \\(null==${extra}\\|\\|null!=${extra}\\.recording\\?\\k<handlers>\\.onTranscriptSend\\("",\\k<session>\\):\\k<handlers>\\.onTranscriptSend\\("",\\k<session>,${extra}\\)\\)\\}$`,
  ].join("");
  const matched = new RegExp(pattern, "u").exec(body);
  if (!matched) throw Error("Native dictation history/recovery/send/insert body changed");
  return { ...matched.groups, transcript, context };
}

function dictationStatement(source) {
  const lexical = createJavaScriptLexicalIndex(source), stack = [], pairs = { "(": ")", "[": "]", "{": "}" };
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    const char = source[index];
    if (pairs[char]) stack.push(pairs[char]);
    else if (")]}".includes(char)) { if (stack.pop() !== char) return null; }
    else if (char === ";" && stack.length === 0) return { source: source.slice(0, index + 1), end: index + 1 };
  }
  return null;
}

function dictationCaptureClaims(source) {
  if (!source.includes("codexLinuxRecordReplay") && !source.includes("\\u") && !source.includes("\\x")) return [];
  const lexical = createJavaScriptLexicalIndex(source), claims = [];
  const decode = token => token.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
  for (const token of source.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu)) {
    if (!lexical.isCode(token.index)) continue;
    const name = decode(token[0]), tail = source.slice(token.index + token[0].length);
    if (name === "codexLinuxRecordReplayCaptureResult" || name === DICTATION_PUBLIC_API && /^\s*(?:\?\.)?\s*\(/u.test(tail) ||
        name === DICTATION_QUEUE && /^\s*\?\?=\[\]\)\.push\(/u.test(tail)) claims.push(token.index);
  }
  for (const member of source.matchAll(/(?:globalThis|window|self)\s*(?:\?\.)?\s*\[\s*(["'`])((?:\\.|[^\\\n])*?)\1\s*\]/gu)) {
    if (!lexical.isCode(member.index)) continue;
    const name = decode(member[2]).replace(/\\x([0-9a-fA-F]{2})/gu, (_, value) => String.fromCharCode(parseInt(value, 16))), tail = source.slice(member.index + member[0].length);
    if (name === DICTATION_PUBLIC_API && /^\s*(?:\?\.)?\s*\(/u.test(tail) || name === DICTATION_QUEUE && /^\s*\?\?=\[\]\)\.push\(/u.test(tail)) claims.push(member.index);
  }
  return claims;
}

function dictationObjectFields(source) {
  const lexical = createJavaScriptLexicalIndex(source), members = [], fields = new Map();
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if ("([{".includes(source[index])) {
      index = dictationDelimiter(source, index);
      if (index < 0) throw Error("Incomplete native recording context value");
    } else if (source[index] === ",") { members.push(source.slice(start, index)); start = index + 1; }
  }
  members.push(source.slice(start));
  for (const member of members) {
    const head = /^("(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*):/u.exec(member);
    if (!head) throw Error("Unsupported native recording context field");
    const key = head[1].startsWith('"') ? JSON.parse(head[1]) : head[1];
    if (fields.has(key)) throw Error("Duplicate native recording context field");
    fields.set(key, member.slice(head[0].length));
  }
  return fields;
}

function dictationSeamGlobals(module, hook, callback, inner) {
  const body = module.moduleSource;
  const scopes = [
    { params: module.params.join(","), body },
    { params: hook.params, body: body.slice(hook.open + 1, hook.end) },
    { params: callback.params, body: body.slice(callback.open + 1, callback.end) },
    { params: "", body: body.slice(inner.open + 1, inner.end) },
    { params: "", body: body.slice(inner.tryOpen + 1, inner.tryEnd) },
  ];
  for (const scope of scopes) {
    try { new Script(`"use strict";async function captureGlobalsProbe(${scope.params}){${scope.body}\n;let globalThis;let Date;}`); }
    catch { throw Error("Native capture seam shadows its globalThis or Date capability"); }
  }
}

function dictationNativeCallback(module, hook, block, roles) {
  const body = module.moduleSource, id = DICTATION_IDENTIFIER;
  const arrows = dictationMatches(body, new RegExp(`(?<binding>${id})=async\\((?<request>${id}),(?<retry>${id})\\)=>\\{`, "gu"));
  const outer = dictationOne(arrows.map(head => ({ head, open: head.index + head[0].length - 1, end: findMatchingBrace(body, head.index + head[0].length - 1) }))
    .filter(fn => hook.open < fn.head.index && fn.open < block.index && block.end < fn.end && fn.end < hook.end), "native live dictation callback");
  const callback = body.slice(outer.open + 1, outer.end), request = escapeRegExp(outer.head.groups.request), retry = escapeRegExp(outer.head.groups.retry);
  const start = new RegExp(`^let (?<retrying>${id})=void 0!==${retry}&&${retry},(?<action>${id})=\\{\\.\\.\\.${request},abortController:new AbortController\\},(?<abort>${id})=\\(\\)=>\\{\\k<action>\\.abortController\\.abort\\(\\)\\};${request}\\.signal\\?\\.addEventListener\\("abort",\\k<abort>,\\{once:!0\\}\\),${request}\\.signal\\?\\.aborted&&\\k<abort>\\(\\);let\\{analytics:(?<analytics>${id}),audio:(?<audio>${id}),handlers:(?<handlers>${id}),recordingPersistence:(?<history>${id}),requestDurationMs:(?<duration>${id})\\}=\\k<action>,(?<attached>${id})="CHATGPT_DICTATION_RECORDING_SOURCE_ATTACHED_AUDIO"===\\k<analytics>\\.recordingSource,`, "u").exec(callback);
  if (!start) throw Error("Native dictation callback request/abort ABI changed");
  const initialFlags = new RegExp(`^(?<completed>${id})=!1,(?<logged>${id})=!1;`, "u").exec(callback.slice(start[0].length));
  if (!initialFlags) throw Error("Native dictation completion flags changed");
  for (const name of ["retrying", "action", "analytics", "handlers", "history", "attached"]) if (start.groups[name] !== roles[name]) throw Error("Native dictation callback role changed: " + name);
  const action = escapeRegExp(roles.action), handlers = escapeRegExp(roles.handlers), analytics = escapeRegExp(roles.analytics), text = escapeRegExp(roles.transcript), context = escapeRegExp(roles.context);
  const before = body.slice(outer.open + 1, block.index);
  const clean = dictationOne(dictationMatches(before, new RegExp(`let (?<cleaned>${id})=null!=${handlers}\\.chatgpt\\?(?<response>${id})\\.text:await \\(0,(?<cleanup>${id})\\.(?<cleanupExport>${id})\\)\\(\\{transcript:\\k<response>\\.text,surroundingText:${handlers}\\.getSurroundingText\\?\\.\\(\\)\\?\\?null,cleanupEnabled:(?<enabled>${id}),signal:${action}\\.abortController\\.signal\\}\\);if\\(${action}\\.isCurrent\\?\\.\\(\\)===!1&&${action}\\.abortController\\.abort\\(\\),${action}\\.abortController\\.signal\\.aborted\\)return;(?<recoveryRef>${id})\\.current=null,${escapeRegExp(roles.mounted)}\\.current&&(?<recoverState>${id})\\(!1\\);let ${text}=null==${handlers}\\.chatgpt\\?\\k<cleaned>\\.trim\\(\\):\\k<cleaned>;\\(0,(?<persistence>${id})\\.(?<persistenceExport>${id})\\)\\((?<store>${id})\\.get\\((?<settings>${id})\\.(?<settingsExport>${id})\\),${analytics},${text}\\);let ${escapeRegExp(roles.usedRetry)}=!1,(?<recording>${id})=null!=${action}\\.recordingSignal&&!${action}\\.recordingSignal\\.aborted&&${escapeRegExp(start.groups.audio)}\\.size>0\\?${escapeRegExp(start.groups.audio)}:void 0,${context}=null==${handlers}\\.chatgpt&&null==\\k<recording>\\?void 0:\\{`, "gu")), "native sanitized transcript/current-signal producer");
  const contextOpen = clean.index + clean[0].length - 1, contextEnd = findMatchingBrace(before, contextOpen);
  if (contextEnd < contextOpen) throw Error("Native dictation recording context is incomplete");
  const fields = dictationObjectFields(before.slice(contextOpen + 1, contextEnd));
  const required = {
    signal: `${roles.action}.abortController.signal`, response: clean.groups.response,
    recording: clean.groups.recording, recordingSignal: `${roles.action}.recordingSignal`,
    recordingDurationMs: `${roles.analytics}.recordDurationMs`, dictationSessionId: `${roles.analytics}.dictationSessionId`,
    attemptId: `${roles.analytics}.attemptId`, transcriptReceivedTs: `${roles.analytics}.timings?.transcriptReceivedTs??Date.now()`,
  };
  if (!new RegExp(`^${id}$`, "u").test(fields.get("assetResponse") ?? "") || Object.entries(required).some(([name, value]) => fields.get(name) !== value)) throw Error("Native dictation recording/session context changed");
  const metadata = new RegExp(`^;(?<activeRef>${id})\\.current=null,${escapeRegExp(roles.mounted)}\\.current&&(?<reset>${id})\\(void 0\\);let ${escapeRegExp(roles.metadata)}=\\{action:${action}\\.action,audioLost:!1,reason:"success",retrySameAudioAvailable:!1,stopReason:(?<stopRef>${id})\\.current,transcript:${text},transcriptionStartedAtMs:(?<started>${id})\\};$`, "u").exec(before.slice(contextEnd + 1));
  if (!metadata) throw Error("Native dictation completion metadata changed");
  const asr = dictationOne(dictationMatches(before.slice(0, clean.index), new RegExp(`(?<![\\w$.])${escapeRegExp(clean.groups.response)}=await \\(`, "gu")), "native ASR response producer");
  const asrOpen = asr.index + asr[0].length - 1, asrEnd = dictationDelimiter(before, asrOpen);
  const asrSource = before.slice(asrOpen + 1, asrEnd);
  if (asrEnd < asrOpen || !asrSource.startsWith(`null!=${roles.action}.recovery&&!${roles.action}.streamingSession?.hasBoundaries()?`) ||
      !asrSource.includes(`signal:${roles.action}.abortController.signal`) || !asrSource.includes(`onTranscriptUpdate:`) || !asrSource.includes(`${roles.action}.isCurrent?.()===!1?${roles.action}.abortController.abort()`)) throw Error("Native ASR/current-session linkage changed");
  const dispatched = dictationOne(dictationMatches(before, new RegExp(`${analytics}\\.performance\\.mark\\("final_received"\\)`, "gu")), "native final transcript analytics");
  if (!(asrEnd < dispatched.index && dispatched.index < clean.index)) throw Error("Native ASR/cleanup ordering changed");
  const hookBody = body.slice(hook.open + 1, hook.end);
  if (dictationMatches(hookBody, new RegExp(`\\{[^{}]*cleanupEnabled:${escapeRegExp(clean.groups.enabled)}[^{}]*\\}=${escapeRegExp(hook.params)}(?=[,;])`, "gu"), true).length !== 1) throw Error("Native cleanup-enabled input changed");
  const tail = body.slice(outer.end + 1);
  const memo = new RegExp(`^,(?<stores>${id}\\[\\d+\\]=${id}(?:,${id}\\[\\d+\\]=${id})*)\\):${escapeRegExp(outer.head.groups.binding)}=(?<cache>${id})\\[(?<slot>\\d+)\\];let (?<alias>${id})=${escapeRegExp(outer.head.groups.binding)};`, "u").exec(tail);
  if (!memo) throw Error("Native dictation callback memo/alias linkage changed");
  const stores = memo.groups.stores.split(",").map(store => new RegExp(`^${escapeRegExp(memo.groups.cache)}\\[(\\d+)\\]=(${id})$`, "u").exec(store));
  if (stores.some(store => store == null) || new Set(stores.map(store => store[1])).size !== stores.length || stores.filter(store => store[1] === memo.groups.slot && store[2] === outer.head.groups.binding).length !== 1) throw Error("Native dictation callback memo stores changed");
  const alias = memo.groups.alias;
  const aliasStart = outer.end + 1 + memo[0].indexOf(`let ${alias}=`) + "let ".length;
  dictationBindingProbe(module, alias, aliasStart, hook.exportName);
  const calls = dictationMatches(body.slice(hook.open + 1, hook.end), new RegExp(`(?<![\\w$.])${escapeRegExp(alias)}\\(`, "gu"));
  if (calls.length !== 3) throw Error("Native dictation callback consumer set changed");
  const argumentsList = calls.map(call => {
    const open = hook.open + 1 + call.index + call[0].length - 1, end = dictationDelimiter(body, open);
    if (end < open) throw Error("Incomplete native dictation callback arguments");
    const prefix = body.slice(0, hook.open + 1 + call.index).trimEnd();
    return { source: body.slice(open + 1, end), form: /\bawait$/u.test(prefix) ? "await" : /\breturn$/u.test(prefix) ? "return" : "other" };
  });
  const consumers = argumentsList.map(row => {
    if (row.form === "await" && new RegExp(`^\\{\\.\\.\\.${id},analytics:${id}\\},!0$`, "u").test(row.source)) return "retry";
    if (!row.source.startsWith("{") || !row.source.endsWith("}")) return "unsupported";
    const fields = dictationObjectFields(row.source.slice(1, -1));
    const identifier = value => new RegExp(`^${id}$`, "u").test(value ?? "");
    if (row.form === "await" && identifier(fields.get("action")) && identifier(fields.get("isCurrent")) &&
        ["recovery", "analytics", "audio", "recordingSignal", "streamingSession", "handlers", "language", "recordingPersistence", "requestDurationMs"].every(name => fields.has(name)) &&
        identifier(fields.get("handlers")) && identifier(fields.get("recordingPersistence")) &&
        new RegExp(`^null==${escapeRegExp(fields.get("handlers"))}\\.chatgpt\\?void 0:${id}$`, "u").test(fields.get("requestDurationMs"))) return "stop";
    if (row.form === "return" && fields.get("action") === '"insert"' && fields.get("recordingPersistence") === "null" &&
        ["analytics", "audio", "streamingSession", "language", "requestDurationMs", "signal"].every(name => fields.has(name)) &&
        new RegExp(`^\\{\\.\\.\\.${id},onTranscriptInsert:${id}\\}$`, "u").test(fields.get("handlers") ?? "")) return "file-insert";
    return "unsupported";
  });
  if (consumers.sort().join(",") !== "file-insert,retry,stop") throw Error("Native stop/retry/file-insert callback ABI changed");
  const inner = dictationOne(dictationMatches(body, /async\(\)=>\{try\{/gu).map(head => {
    const open = head.index + "async()=>".length, end = findMatchingBrace(body, open);
    const tryOpen = head.index + head[0].length - 1, tryEnd = findMatchingBrace(body, tryOpen);
    return { start: head.index, open, end, tryOpen, tryEnd };
  }).filter(fn => outer.open < fn.start && fn.tryOpen < block.index && block.end < fn.tryEnd && fn.end < outer.end), "native awaited ASR completion body");
  if (!body.slice(0, inner.start).endsWith("return await (") || !body.slice(inner.end + 1).startsWith(")().finally(()=>{")) throw Error("Native dictation awaited completion/finalizer linkage changed");
  const finalizerOpen = inner.end + 1 + ")().finally(()=>".length, finalizerEnd = findMatchingBrace(body, finalizerOpen);
  const finalizer = body.slice(finalizerOpen + 1, finalizerEnd);
  if (!finalizer.startsWith(`${outer.head.groups.request}.signal?.removeEventListener("abort",${start.groups.abort})`) || !finalizer.includes(`${roles.pendingAction}.current===${roles.action}`)) throw Error("Native dictation abort/current-session finalizer changed");
  const remainder = body.slice(block.end + 1, inner.tryEnd);
  const remaining = new RegExp(`^else null!=${handlers}\\.onRecoveryChange&&\\(null!=${action}\\.recovery\\|\\|(?<recovered>${id})\\)\\?\\(${escapeRegExp(clean.groups.recoveryRef)}\\.current=${action},${escapeRegExp(roles.mounted)}\\.current&&${escapeRegExp(clean.groups.recoverState)}\\(!0\\),${escapeRegExp(roles.recover)}\\("failed"\\)\\):${handlers}\\.onTranscriptCancel\\?\\.\\(\\);if\\(${action}\\.abortController\\.signal\\.aborted\\)return;${escapeRegExp(roles.state)}\\(${analytics},\\{\\.\\.\\.${escapeRegExp(roles.metadata)},action:${action}\\.action,recovery:null==${action}\\.recovery\\|\\|null==${handlers}\\.onRecoveryChange\\?void 0:\\{phase:${action}\\.recovery\\.phase,transcriptInserted:${escapeRegExp(roles.usedRetry)},retrySameAudioAvailable:${escapeRegExp(roles.mounted)}\\.current&&${escapeRegExp(roles.generation)}===${escapeRegExp(roles.currentGeneration)}\\.current&&${escapeRegExp(clean.groups.recoveryRef)}\\.current===${action}\\}\\}\\),(?<completed>${id})=!0$`, "u").exec(remainder);
  if (!remaining || remaining.groups.completed !== initialFlags.groups.completed || !asrSource.includes(`onRecover:()=>{${remaining.groups.recovered}=!0}`)) throw Error("Native dictation cancel/stale/recovery completion changed");
  const flags = `let ${metadata.groups.started}=Date.now(),${remaining.groups.recovered}=!1,${roles.delivered}=!1;return await (`;
  if (!before.includes(flags) || body.slice(finalizerEnd + 1, outer.end) !== `),${initialFlags.groups.completed}`) throw Error("Native dictation completion flag/return linkage changed");
  dictationSeamGlobals(module, hook, { ...outer, params: `${outer.head.groups.request},${outer.head.groups.retry}` }, inner);
  const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const imports = [...new Set([roles.dispatcher, clean.groups.cleanup, clean.groups.persistence, clean.groups.settings])].map(name => {
    const binding = findRspackRequireBinding(module, name);
    if (binding == null) throw Error("Native dictation namespace is not a static CJS import");
    dictationBindingProbe(module, name, binding.start - module.start, hook.exportName);
    return binding;
  });
  return { outer, clean, metadata, alias, imports, nativeConsumers: argumentsList };
}

function recordReplayCurrentChatGptBlocks(source) {
  const id = DICTATION_IDENTIFIER, rows = [];
  const heads = dictationMatches(source, new RegExp(`if\\((?<transcript>${id})\\.length>0\\|\\|null!=(?<context>${id})\\)\\{`, "gu"));
  for (const head of heads) {
    const open = head.index + head[0].length - 1, end = findMatchingBrace(source, open);
    if (end < open) throw Error("Incomplete native dictation completion block");
    const content = source.slice(open + 1, end);
    if (!dictationMatches(content, /\.dispatchMessage\("global-dictation-record-history-item"/gu).length || !dictationMatches(content, /\.performance\.mark\("transcript_dispatched"\)/gu).length) continue;
    rows.push({ index: head.index, open, end, transcript: head.groups.transcript, context: head.groups.context, source: source.slice(head.index, end + 1) });
  }
  return rows;
}

function inspectRecordReplayDictationModule(module) {
  const body = module.moduleSource;
  const block = dictationOne(recordReplayCurrentChatGptBlocks(body), "native dictation completion block");
  const originalContent = body.slice(block.open + 1, block.end), first = dictationStatement(originalContent);
  const contribution = first && dictationCaptureClaims(first.source).length ? first : null;
  const content = contribution ? originalContent.slice(contribution.end) : originalContent;
  const roles = dictationNativeBody(content, block.transcript, block.context);
  const rawBody = contribution ? body.slice(0, block.open + 1) + content + body.slice(block.end) : body;
  const rawModule = { ...module, moduleSource: rawBody };
  const rawBlock = dictationOne(recordReplayCurrentChatGptBlocks(rawBody), "stripped native completion block");
  const hook = dictationRootFunction(rawModule, rawBlock.index);
  const callback = dictationNativeCallback(rawModule, hook, rawBlock, roles);
  const expected = recordReplayTranscriptCaptureExpression(roles.transcript, `${roles.action}.action`) + ";";
  if (contribution && contribution.source !== expected) throw Error("Incomplete or mismatched dictation capture contribution");
  const start = block.open + 1, end = start + (contribution?.end ?? 0);
  if (dictationCaptureClaims(body).some(index => index < start || index >= end)) throw Error("Orphan or duplicate dictation capture contribution");
  const patchedBody = rawBody.slice(0, rawBlock.open + 1) + expected + rawBody.slice(rawBlock.open + 1);
  if (contribution && patchedBody !== body) throw Error("Dictation capture strip/reapply changed native bytes");
  return { module, roles, hook, callback, rawBody, patchedBody, contribution: contribution ? { start, end } : null, kind: contribution ? "patched" : "current" };
}

function dictationChunkGlobals(source) {
  const lexical = createJavaScriptLexicalIndex(source), edits = [];
  for (const imported of source.matchAll(/\bimport(?:\*as\s+([\w$]+)|\{([^}]+)\})\s+from\s*["'][^"'\n]+["'];/gu)) {
    if (!lexical.isRoot(imported.index)) continue;
    const locals = imported[1] ? [imported[1]] : imported[2].split(",").map(item => item.trim().split(/\s+as\s+/u).at(-1));
    if (locals.some(name => ["Date", "globalThis"].includes(name))) throw Error("Dictation chunk import shadows a capture capability");
    edits.push({ start: imported.index, end: imported.index + imported[0].length });
  }
  for (const exported of source.matchAll(/\bexport\s+(?=const\b|let\b|var\b|function\b|class\b)/gu)) {
    if (lexical.isRoot(exported.index)) edits.push({ start: exported.index, end: exported.index + exported[0].length });
  }
  let projected = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) projected = projected.slice(0, edit.start) + source.slice(edit.start, edit.end).replace(/[^\r\n]/gu, " ") + projected.slice(edit.end);
  try { new Script(`"use strict";async function captureChunkGlobals(){${projected}\n;let Date;let globalThis;}`); }
  catch { throw Error("Dictation chunk shadows a capture capability or has unsupported module syntax"); }
}

function recordReplayDictationTranscriptState(source) {
  try {
    const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
    const modules = [...rspackModuleFactories(source, "Record & Replay dictation chunk")];
    dictationChunkGlobals(source);
    const candidates = modules.filter(module => recordReplayCurrentChatGptBlocks(module.moduleSource).length > 0);
    const module = dictationOne(candidates, "published dictation producer");
    const contract = inspectRecordReplayDictationModule(module);
    const allowed = contract.contribution && { start: module.start + contract.contribution.start, end: module.start + contract.contribution.end };
    if (dictationCaptureClaims(source).some(index => !allowed || index < allowed.start || index >= allowed.end)) throw Error("Dictation capture escaped its native module");
    return { ...contract, kind: contract.kind };
  } catch (error) { return { kind: "partial", reason: error.message }; }
}

const RUNTIME_ENTRY_EXPORT = /export\{[A-Za-z_$][\w$]* as __webpack_require__\}/;

const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const RECORD_REPLAY_HUD_GLOBALS = ["codexLinuxRecordReplayHudVersion", "codexLinuxRecordReplayCaptureTranscript"];
const RECORD_REPLAY_HUD_WRITE_OPERATORS = ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??=", "++", "--"];
const recordReplayHudDependencyFacts = new Map();

function hudStartsWrite(source) {
  const suffix = source.replace(/^\s*(?:\)\s*)*/u, "");
  return RECORD_REPLAY_HUD_WRITE_OPERATORS.some(operator => suffix.startsWith(operator) &&
    (operator !== "=" || suffix[1] !== "=" && suffix[1] !== ">"));
}

function hudPatternWrites(source, start, end, lexical) {
  if (!/^\s*(?:\)\s*)*[,}\]]/u.test(source.slice(end))) return false;
  // Keep parentheses around a complete member outside the replacement range.
  // Parentheses that form its receiver stay part of the assignment target.
  while (source[start] === "(") {
    let depth = 0, close = -1;
    for (let index = start; index < source.length; index++) {
      if (!lexical.isCode(index)) continue;
      if (source[index] === "(") depth++;
      else if (source[index] === ")" && --depth === 0) { close = index; break; }
    }
    if (close < end) break;
    start++;
    while (/\s/u.test(source[start] ?? "") && start < source.length) start++;
  }
  const opened = [], patterns = [];
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (source[index] === "[" || source[index] === "{") opened.push(index);
    else if (source[index] === "]" || source[index] === "}") {
      const open = opened.pop();
      if (open < start && index >= end) patterns.push({ open, close: index });
    }
  }
  for (const { open, close } of patterns) {
    const tail = source.slice(close + 1).replace(/^\s*(?:\)\s*)*/u, "");
    const assignment = tail.startsWith("=") && tail[1] !== "=" && tail[1] !== ">";
    const iteration = /^(?:of|in)\b/u.test(tail) && /\bfor(?:\s+await)?\s*\(\s*$/u.test(source.slice(0, open));
    if (!assignment && !iteration) continue;
    const pattern = source.slice(open, close + 1);
    const replaced = source.slice(open, start) + "(0)" + source.slice(end, close + 1);
    const probe = value => assignment ? `(${value}=null)` : `for(${value} of []){}`;
    try { new Script(probe(pattern)); } catch { continue; }
    try { new Script(probe(replaced)); } catch { return true; }
  }
  return false;
}

function hudMatches(source, pattern, root = false) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(pattern)].filter(match => lexical.isCode(match.index) && (!root || lexical.isRoot(match.index)));
}

function hudOne(values, reason) {
  if (values.length !== 1) throw new Error(`${reason} matched ${values.length} times`);
  return values[0];
}

function hudOwnClaims(source) {
  const identifier = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu;
  const decode = token => token.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
  if (!source.includes("codexLinuxRecordReplay") && !source.includes("codex-linux-record-replay-") &&
      !source.includes("\\u") && !source.includes("\\x")) return [];
  const lexical = createJavaScriptLexicalIndex(source), claims = [];
  const destructive = (start, end) => hudStartsWrite(source.slice(end)) ||
    /(?:\bdelete|\+\+|--)\s*\(*\s*(?:(?:globalThis|window|self)\s*\)*\s*(?:\?\.|\.)\s*)?$/u.test(source.slice(0, start));
  for (const token of source.matchAll(identifier)) {
    if (!lexical.isCode(token.index)) continue;
    const decoded = decode(token[0]);
    if (!RECORD_REPLAY_HUD_GLOBALS.includes(decoded)) continue;
    const receiver = /(?:\(+\s*)?(?:globalThis|window|self)\s*\)*\s*(?:\?\.|\.)\s*$/u.exec(source.slice(0, token.index));
    if (destructive(token.index, token.index + token[0].length) || receiver && hudPatternWrites(source, receiver.index, token.index + token[0].length, lexical)) claims.push(token.index);
  }
  for (const match of source.matchAll(/(?:\(+\s*)?(?:globalThis|window|self)\s*\)*\s*(?:\?\.)?\s*\[\s*(["'`])((?:\\.|[^\\\n])*?)\1\s*\]/gu)) {
    if (!lexical.isCode(match.index)) continue;
    const name = decode(match[2]).replace(/\\x([0-9a-fA-F]{2})/gu, (_, value) => String.fromCharCode(parseInt(value, 16)));
    if (RECORD_REPLAY_HUD_GLOBALS.includes(name) && (destructive(match.index, match.index + match[0].length) || hudPatternWrites(source, match.index, match.index + match[0].length, lexical))) claims.push(match.index);
  }
  for (const match of source.matchAll(/(?:Object\s*\.\s*defineProperty|Reflect\s*\.\s*(?:defineProperty|deleteProperty|set))\s*\(\s*(?:globalThis|window|self)\s*,\s*(["'`])((?:\\.|[^\\\n])*?)\1/gu)) {
    if (!lexical.isCode(match.index)) continue;
    const name = decode(match[2]).replace(/\\x([0-9a-fA-F]{2})/gu, (_, value) => String.fromCharCode(parseInt(value, 16)));
    if (RECORD_REPLAY_HUD_GLOBALS.includes(name)) claims.push(match.index);
  }
  for (const pattern of [
    /\.(?:id|className)\s*=\s*(["'`])((?:\\.|[^\\\n])*?)\1/gu,
    /\[\s*["'`](?:id|className)["'`]\s*\]\s*=\s*(["'`])((?:\\.|[^\\\n])*?)\1/gu,
    /\.setAttribute\(\s*["'`](?:id|class)["'`]\s*,\s*(["'`])((?:\\.|[^\\\n])*?)\1/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (!lexical.isCode(match.index)) continue;
      const value = decode(match[2]).replace(/\\x([0-9a-fA-F]{2})/gu, (_, code) => String.fromCharCode(parseInt(code, 16)));
      if (value.split(/\s+/u).some(name => name.startsWith("codex-linux-record-replay-"))) claims.push(match.index);
    }
  }
  return claims;
}

function inspectRecordReplayHudPayload(source) {
  const expected = recordReplayHudRuntimeSource(), lexical = createJavaScriptLexicalIndex(source), blocks = [];
  for (let index = source.indexOf(expected); index >= 0; index = source.indexOf(expected, index + 1)) {
    if (lexical.isCode(index)) blocks.push({ start: index, end: index + expected.length, root: lexical.isRoot(index) });
  }
  const claims = hudOwnClaims(source);
  if (blocks.length === 0 && claims.length === 0) return { state: "current" };
  if (blocks.length !== 1 || !blocks[0].root || claims.some(index => index < blocks[0].start || index >= blocks[0].end)) {
    throw new Error("Incomplete, duplicate or misplaced Record & Replay HUD runtime");
  }
  const block = blocks[0], stripped = source.slice(0, block.start) + source.slice(block.end);
  if (stripped.slice(0, block.start) + expected + stripped.slice(block.start) !== source) throw new Error("Record & Replay HUD canonical reapply failed");
  return { state: "patched", block: blocks[0] };
}

function hudBindingScopes(source, script, lexical) {
  const parentheses = new Map(), stack = [], scopes = [];
  let probeName = "__codexRecordReplayHudScopeProbe";
  while (source.includes(probeName)) probeName += "_";
  const parses = text => { try { new Script('"use strict";\n' + text); return true; } catch { return false; } };
  const parameterShadows = (parameters, name) => parses(`function probe(${parameters}){let ${probeName};}`) &&
    !parses(`function probe(${parameters}){let ${name};}`);
  for (let index = 0; index < source.length; index++) {
    if (!lexical.isCode(index)) continue;
    if (source[index] === "(") stack.push(index);
    else if (source[index] === ")") parentheses.set(index, stack.pop());
  }
  for (let open = 0; open < source.length; open++) {
    if (source[open] !== "{" || !lexical.isCode(open)) continue;
    const end = lexical.matchingBrace(open);
    if (end < 0) continue;
    const prefix = source.slice(0, open).trimEnd(), close = prefix.length - 1;
    const parameterOpen = prefix[close] === ")" ? parentheses.get(close) : null;
    const beforeParameters = parameterOpen == null ? "" : source.slice(0, parameterOpen).trimEnd();
    const control = /\b(if|for|while|switch|with)\s*$/u.test(beforeParameters);
    const functionScope = prefix.endsWith("=>") || /\bstatic$/u.test(prefix) || parameterOpen != null && !control;
    const namedFunction = /\bfunction\s*\*?\s*([\w$]+)\s*$/u.exec(beforeParameters);
    const expressionName = namedFunction && /(?:[=(:,\[]|\breturn)\s*$/u.test(beforeParameters.slice(0, namedFunction.index)) ? namedFunction[1] : null;
    const insertion = script.slice(0, open + 1), remainder = script.slice(open + 1);
    let validBlock;
    const shadows = name => {
      if (expressionName === name) return true;
      if (validBlock == null) validBlock = parses(insertion + `let ${probeName};` + remainder);
      if (!validBlock || parses(insertion + `let ${name};` + remainder)) return false;
      return functionScope || !parses(insertion + `var ${name};` + remainder);
    };
    scopes.push({ start: open, end, shadows });
    if (expressionName) scopes.push({ start: namedFunction.index, end, shadows: name => name === expressionName });
    if (parameterOpen != null && functionScope) scopes.push({ start: parameterOpen, end: open, shadows: name => parameterShadows(source.slice(parameterOpen + 1, close), name) });
    if (parameterOpen != null && /\bfor\s*$/u.test(beforeParameters)) {
      const header = source.slice(parameterOpen + 1, close);
      const separator = [...header.matchAll(/;|\b(?:of|in)\b/gu)].find(match => lexical.isCode(parameterOpen + 1 + match.index));
      const declaration = separator == null ? "" : header.slice(0, separator.index) + (separator[0] === ";" ? "" : "=null");
      if (/^\s*(?:let|const)\s/u.test(declaration)) scopes.push({ start: parameterOpen, end, shadows: name =>
        parses(`function probe(){${declaration};let ${probeName};}`) && !parses(`function probe(){${declaration};let ${name};}`) });
    }
  }
  for (const arrow of source.matchAll(/=>/gu)) {
    if (!lexical.isCode(arrow.index)) continue;
    const prefix = source.slice(0, arrow.index).trimEnd(), close = prefix.length - 1;
    const parameterOpen = prefix[close] === ")" ? parentheses.get(close) : null;
    const single = /([A-Za-z_$][\w$]*)$/u.exec(prefix);
    const parameters = parameterOpen == null ? single?.[1] : source.slice(parameterOpen + 1, close);
    if (parameters == null) continue;
    let body = arrow.index + 2;
    while (/\s/u.test(source[body] ?? "") && body < source.length) body++;
    let end = body, depth = 0;
    if (source[body] === "{") end = lexical.matchingBrace(body);
    else for (; end < source.length; end++) {
      if (!lexical.isCode(end)) continue;
      const char = source[end];
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) { if (depth === 0) break; depth--; }
      else if (depth === 0 && (char === "," || char === ";")) break;
    }
    scopes.push({ start: parameterOpen ?? prefix.length - parameters.length, end, shadows: name => parameterShadows(parameters, name) });
  }
  return (name, index) => scopes.some(scope => scope.start <= index && index < scope.end && scope.shadows(name));
}

function hudAssertRootBinding(source, name, authorized) {
  const lexical = createJavaScriptLexicalIndex(source);
  let script = source;
  const masked = hudMatches(source, /\b(?:import\*as [\w$]+ from"[^"\n]+";|export\{[^}]+\};)/gu, true);
  for (const match of [...masked].reverse()) script = script.slice(0, match.index) + " ".repeat(match[0].length) + script.slice(match.index + match[0].length);
  script = script.replace(/import\.meta/gu, (value, index) => lexical.isCode(index) ? "({})       " : value);
  const shadowed = hudBindingScopes(source, script, lexical);
  const parsesReplacement = (match, replacement) => {
    try { new Script('"use strict";\n' + script.slice(0, match.index) + replacement + script.slice(match.index + match[0].length)); return true; }
    catch { return false; }
  };
  const references = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu;
  for (const match of source.matchAll(references)) {
    if (!lexical.isCode(match.index) || /[\w$.]/u.test(source[match.index - 1] ?? "")) continue;
    const decoded = match[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (decoded !== name || authorized.includes(match.index) || masked.some(row => row.index <= match.index && match.index < row.index + row[0].length)) continue;
    const suffix = source.slice(match.index + match[0].length), prefix = source.slice(0, match.index);
    if (!lexical.isRoot(match.index) && !hudStartsWrite(suffix) && !/^\s*(?:\)\s*)*(?:[,}\]]|of\b|in\b)/u.test(suffix) && !/(?:\+\+|--)\s*\(*\s*$/u.test(prefix)) continue;
    if (parsesReplacement(match, "(0)") || parsesReplacement(match, name + ":(0)") || shadowed(name, match.index)) continue;
    throw new Error("Native runtime binding has an additional declaration or write: " + name);
  }
}

function inspectRecordReplayHudEntry(source) {
  const id = "[A-Za-z_$][\\w$]*";
  const exportMatch = hudOne(hudMatches(source, new RegExp(`\\bexport\\{(${id}) as __webpack_require__\\}`, "gu"), true), "native require export");
  const exported = exportMatch[1], own = inspectRecordReplayHudPayload(source);
  if (own.state === "patched" && own.block.start < exportMatch.index + exportMatch[0].length) throw new Error("Record & Replay HUD precedes its native entry export");
  const alias = hudOne(hudMatches(source, new RegExp(`\\bvar ${escapeRegExp(exported)}=(${id});`, "gu"), true), "native require export binding");
  const requireName = alias[1];
  const head = hudOne(hudMatches(source, new RegExp(`\\bfunction ${escapeRegExp(requireName)}\\((${id})\\)\\{`, "gu"), true), "native require function");
  const open = head.index + head[0].length - 1, close = findMatchingBrace(source, open);
  const requireBody = source.slice(open + 1, close);
  const invocation = hudOne(hudMatches(requireBody, new RegExp(`(${id})\\[${escapeRegExp(head[1])}\\]\\.call\\((${id})\\.exports,\\2,\\2\\.exports,${escapeRegExp(requireName)}\\)`, "gu")), "native module invocation");
  const table = invocation[1];
  const tableHead = hudOne(hudMatches(source, new RegExp(`(?<![\\w$.])${escapeRegExp(table)}=\\{`, "gu"), true), "native bootstrap registry");
  const tableOpen = tableHead.index + tableHead[0].length - 1, tableClose = findMatchingBrace(source, tableOpen);
  hudAssertRootBinding(source, exported, [alias.index + "var ".length]);
  hudAssertRootBinding(source, requireName, [head.index + "function ".length]);
  hudAssertRootBinding(source, table, [tableHead.index]);
  const registryBindings = hudMatches(source, new RegExp(`${escapeRegExp(requireName)}\\.m=`, "gu"), true);
  if (registryBindings.length !== 1 || !new RegExp(`^${escapeRegExp(requireName)}\\.m=${escapeRegExp(table)}(?![\\w$])`, "u").test(source.slice(registryBindings[0].index))) throw new Error("Native require registry binding changed");
  const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
  const carrierPrefix = "exports.ids=[0],exports.modules=";
  const carrier = carrierPrefix + source.slice(tableOpen, tableClose + 1) + ";";
  const factories = mainProcessFactories(carrier).map(factory => {
    const start = tableOpen + factory.start - carrierPrefix.length;
    const end = tableOpen + factory.end - carrierPrefix.length;
    if (source.slice(start, end) !== factory.body) throw new Error("Native registry source range changed");
    return { moduleId: factory.identity, params: factory.parameters, moduleSource: factory.body, start, end };
  });
  const decoder = hudOne(factories.filter(factory => hudMatches(factory.moduleSource, /\b(?:let|const) ([\w$]+)="codex-host-chunked-message-v1"/gu, true).length === 1), "native host decoder");
  const marker = hudMatches(decoder.moduleSource, /\b(?:let|const) ([\w$]+)="codex-host-chunked-message-v1"/gu, true)[0][1];
  const publication = hudOne(hudMatches(decoder.moduleSource, new RegExp(`${escapeRegExp(decoder.params[2])}\\.d\\(${escapeRegExp(decoder.params[1])},\\{\\},\\{(${id}):${escapeRegExp(marker)},(${id}):function\\((${id})\\)\\{`, "gu"), true), "native decoder publication");
  const validatorOpen = publication.index + publication[0].length - 1, validatorClose = findMatchingBrace(decoder.moduleSource, validatorOpen);
  const validator = decoder.moduleSource.slice(validatorOpen + 1, validatorClose), parameter = publication[3];
  for (const field of ["marker", "transferId", "sequence", "kind", "tokens"]) {
    if (!validator.includes(JSON.stringify(field))) throw new Error("Native decoder field contract changed");
  }
  if (!hudMatches(validator, new RegExp(`${escapeRegExp(parameter)}\\.marker===${escapeRegExp(marker)}`, "gu")).length ||
      !hudMatches(validator, new RegExp(`Number\\.isSafeInteger\\(${escapeRegExp(parameter)}\\.sequence\\)`, "gu")).length ||
      !hudMatches(validator, new RegExp(`Array\\.isArray\\(${escapeRegExp(parameter)}\\.tokens\\)`, "gu")).length) throw new Error("Native decoder validation changed");
  const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const decoderConsumers = factories.flatMap(factory => {
    if (factory === decoder || factory.params.length < 3) return [];
    return hudMatches(factory.moduleSource, new RegExp(`(${id})=${escapeRegExp(factory.params[2])}\\("${escapeRegExp(decoder.moduleId)}"\\)`, "gu"), true)
      .filter(match => findRspackRequireBinding(factory, match[1])?.moduleId === decoder.moduleId)
      .map(match => ({ factory, name: escapeRegExp(match[1]) }));
  });
  const validatorOwner = hudOne(decoderConsumers.filter(row => hudMatches(row.factory.moduleSource,
    new RegExp(`(?:\\(0,${row.name}\\.${escapeRegExp(publication[2])}\\)|${row.name}\\.${escapeRegExp(publication[2])})\\(`, "gu")).length), "native host validator consumer").factory;
  const receiver = hudOne(hudMatches(validatorOwner.moduleSource, new RegExp(`${escapeRegExp(validatorOwner.params[2])}\\.d\\(${escapeRegExp(validatorOwner.params[1])},\\{\\},\\{(${id}):class\\{`, "gu"), true), "native host receiver publication")[1];
  const markerOwner = hudOne(decoderConsumers.filter(row => hudMatches(row.factory.moduleSource,
    new RegExp(`\\.marker===${row.name}\\.${escapeRegExp(publication[1])}(?![\\w$])`, "gu")).length), "native host marker consumer").factory;
  const receiverUses = hudMatches(markerOwner.moduleSource, new RegExp(`(${id})=${escapeRegExp(markerOwner.params[2])}\\("${escapeRegExp(validatorOwner.moduleId)}"\\)`, "gu"), true)
    .filter(match => findRspackRequireBinding(markerOwner, match[1])?.moduleId === validatorOwner.moduleId &&
      hudMatches(markerOwner.moduleSource, new RegExp(`\\bnew ${escapeRegExp(match[1])}\\.${escapeRegExp(receiver)}(?![\\w$])`, "gu")).length);
  hudOne(receiverUses, "native host receiver construction");
  if (!hudMatches(markerOwner.moduleSource, /\.receive\(/gu).length) throw new Error("Native host receiver is not consumed");
  const imports = hudMatches(source, /\bimport\*as ([\w$]+) from"([^"\n]+)";/gu, true).map(match => {
    if (hudMatches(source, new RegExp(`${escapeRegExp(requireName)}\\.C\\(${escapeRegExp(match[1])}\\)`, "gu"), true).length !== 1) throw new Error("Native imported chunk registration changed");
    return match[2];
  });
  if (imports.length === 0) throw new Error("Missing native startup imports");
  const startup = hudOne(hudMatches(source, new RegExp(`\\bvar (${id})=${escapeRegExp(requireName)}\\.O\\(void 0,(\\[[^\\]]*\\]),\\(\\)=>${escapeRegExp(requireName)}\\("([^"\\n]+)"\\)\\);${escapeRegExp(requireName)}\\.O\\(\\1\\);`, "gu"), true), "native startup invocation");
  const prefix = source.slice(0, startup.index).trimEnd();
  if (prefix && !/[;}]/u.test(prefix.at(-1))) throw new Error("Native startup is not an unconditional declaration");
  const chunks = JSON.parse(startup[2]);
  if (!Array.isArray(chunks) || !chunks.length || chunks.some(value => typeof value !== "string" && typeof value !== "number")) throw new Error("Native startup chunk set changed");
  const producer = hudOne(factories.filter(factory => factory.moduleId === startup[3]), "native startup producer");
  const asyncStartup = new RegExp(`${escapeRegExp(producer.params[2])}\\.a\\(${escapeRegExp(producer.params[0])},async function\\(`, "gu");
  if (!hudMatches(producer.moduleSource, asyncStartup).length || !hudMatches(producer.moduleSource, /\bawait /gu).length) throw new Error("Native startup producer is not asynchronous");
  const detached = [/\binitializeDetachedWindow:/gu, /\bwindow\.addEventListener\("pagehide"/gu, /\bSymbol\.dispose/gu, /\bwindow\.close/gu]
    .every(pattern => hudMatches(producer.moduleSource, pattern).length === 1);
  if (!detached && (!hudMatches(producer.moduleSource, /\bPromise\.all\(/gu).length || !hudMatches(producer.moduleSource, /\.then\(/gu).length)) throw new Error("Native main startup producer changed");
  return { requireName, exported, decoderId: decoder.moduleId, imports, chunks: chunks.map(String), startupId: startup[3], role: detached ? "detached" : "main", producer: { start: producer.start, end: producer.end } };
}

function hudAssetNames(extractedDir) {
  const base = path.join(extractedDir, "webview", "assets"), names = [];
  function visit(directory, prefix) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Record & Replay HUD asset inventory directory is not regular");
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Record & Replay HUD asset inventory contains a symlink");
      if (stat.isDirectory()) visit(file, relative + "/");
      else if (stat.isFile() && /\.(?:c|m)?js$/u.test(name)) names.push("webview/assets/" + relative);
    }
  }
  visit(base, "");
  return names;
}

function hudHtmlScripts(source) {
  const scripts = [];
  for (const match of source.replace(/<!--[\s\S]*?-->/gu, "").matchAll(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/giu)) {
    const attrs = new Map();
    for (const attr of match[1].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gu)) {
      const name = attr[1].toLowerCase();
      if (attrs.has(name)) throw new Error("Duplicate native HTML script attribute");
      attrs.set(name, attr[3]);
    }
    if (attrs.get("type") !== "module" || !attrs.has("src")) continue;
    const src = attrs.get("src");
    if (!/^\/?(?:\.\/)?assets\/[A-Za-z0-9_./-]+\.(?:m?js)$/u.test(src) || src.split("/").some(part => part === "..")) throw new Error("Unsupported native HTML module edge");
    scripts.push("webview/" + src.replace(/^\/?(?:\.\/)?/u, ""));
  }
  if (!scripts.length || new Set(scripts).size !== scripts.length) throw new Error("Missing or duplicate native HTML script edge");
  return scripts;
}

function hudDependencyFacts(source) {
  const digest = require("node:crypto").createHash("sha256").update(source).digest("hex");
  if (recordReplayHudDependencyFacts.has(digest)) return recordReplayHudDependencyFacts.get(digest);
  const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const chunks = hudOne(hudMatches(source, /\bexport const __rspack_esm_ids=(\[[^\]]*\])/gu, true), "native dependency chunk registration");
  const facts = { chunks: JSON.parse(chunks[1]).map(String), modules: [...rspackModuleFactories(source)].map(factory => factory.moduleId) };
  if (recordReplayHudDependencyFacts.size > 32) recordReplayHudDependencyFacts.clear();
  recordReplayHudDependencyFacts.set(digest, facts);
  return facts;
}

function applyRecordReplayHudToExtractedApp(extractedDir) {
  const reject = error => { warn(error.message, "Record & Replay HUD runtime patch"); return { matched: 0, changed: 0, changedAssets: [], reason: error.message }; };
  let edits, names, hashes, written;
  const digest = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  try {
    names = hudAssetNames(extractedDir); hashes = new Map();
    const snapshots = new Map(), roles = [], claims = [];
    const read = name => {
      if (!snapshots.has(name)) {
        let file = extractedDir;
        const parts = name.split("/");
        for (const [index, part] of parts.entries()) {
          file = path.join(file, part);
          const stat = fs.lstatSync(file);
          if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error("Native runtime dependency path is not regular");
        }
        const source = fs.readFileSync(file, "utf8"), hash = digest(source);
        if (hashes.has(name) && hashes.get(name) !== hash) throw new Error("Native runtime dependency changed during qualification");
        snapshots.set(name, source);
        hashes.set(name, hash);
      }
      return snapshots.get(name);
    };
    for (const name of names) {
      const value = fs.readFileSync(path.join(extractedDir, name), "utf8"); hashes.set(name, digest(value));
      if (hudOwnClaims(value).length) claims.push(name);
    }
    for (const html of ["webview/index.html", "webview/detached-window.html"]) {
      const scripts = hudHtmlScripts(read(html));
      const owners = [];
      for (const name of scripts) {
        const text = read(name);
        if (RUNTIME_ENTRY_EXPORT.test(text) || hudOwnClaims(text).length) owners.push({ name, text, native: inspectRecordReplayHudEntry(text), own: inspectRecordReplayHudPayload(text) });
      }
      const owner = hudOne(owners, "native window runtime entry");
      if (owner.native.role !== (html === "webview/index.html" ? "main" : "detached")) throw new Error("Native window runtime entry role changed");
      const registeredChunks = new Set();
      for (const imported of owner.native.imports) {
        if (!/^\.\/[A-Za-z0-9_./-]+\.js$/u.test(imported) || imported.split("/").some(part => part === "..")) throw new Error("Unsupported native entry import");
        const name = path.posix.normalize(path.posix.join(path.posix.dirname(owner.name), imported));
        if (!scripts.includes(name)) throw new Error("Native startup import is outside its HTML load edge");
        const facts = hudDependencyFacts(read(name));
        facts.chunks.forEach(id => registeredChunks.add(id));
      }
      if (owner.native.chunks.some(id => !registeredChunks.has(id))) throw new Error("Native startup chunks are unavailable");
      roles.push(owner);
    }
    if (new Set(roles.map(row => row.name)).size !== 2) throw new Error("Native window runtime roles overlap");
    if (new Set(roles.map(row => row.own.state)).size !== 1) throw new Error("Mixed Record & Replay HUD runtime entry cohort");
    if (claims.some(name => !roles.some(row => row.name === name))) throw new Error("Orphan Record & Replay HUD runtime peer");
    written = new Set(roles.filter(row => row.own.state === "current").map(row => row.name));
    for (const owner of roles) {
      const patched = ensureRecordReplayHudRuntime(owner.text);
      if (inspectRecordReplayHudPayload(patched).state !== "patched") throw new Error("Record & Replay HUD runtime poststate is incomplete");
      snapshots.set(owner.name, owner.text);
    }
    edits = [...snapshots].map(([assetName, source]) => ({ assetName, source, patchedSource: written.has(assetName) ? ensureRecordReplayHudRuntime(source) : source }));
  } catch (error) { return reject(error); }
  const verify = () => {
    const current = hudAssetNames(extractedDir);
    if (JSON.stringify(current) !== JSON.stringify(names)) throw new Error("Record & Replay HUD asset inventory changed before commit");
    for (const [name, hash] of hashes) {
      if (digest(fs.readFileSync(path.join(extractedDir, name))) !== hash) throw new Error(`Record & Replay HUD dependency changed before commit: ${name}`);
    }
  };
  verify();
  const originalByFile = new Map(edits.map(edit => [path.join(extractedDir, edit.assetName), Buffer.from(edit.source)]));
  const result = patchWebviewAssets(extractedDir, edits, { writeFileSync(file, bytes) {
    const restoring = originalByFile.get(file)?.equals(bytes);
    if (!restoring) verify();
    fs.writeFileSync(file, bytes);
    if (!restoring) hashes.set(path.relative(extractedDir, file).split(path.sep).join("/"), digest(bytes));
  } });
  return { matched: 1, ...result };
}

function ensureRecordReplayHudRuntime(source) {
  if (inspectRecordReplayHudPayload(source).state === "patched") return source;
  const separator = source.endsWith("\n") ? "" : "\n";
  return source + separator + recordReplayHudRuntimeSource();
}

function applyRecordReplayHudPatch(currentSource) {
  try {
    inspectRecordReplayHudEntry(currentSource);
    return ensureRecordReplayHudRuntime(currentSource);
  } catch (error) {
    warn("Could not find complete rspack webview runtime entry contract - " + error.message, "Record & Replay HUD runtime patch");
    return currentSource;
  }
}

function applyRecordReplayDictationTranscriptPatch(currentSource) {
  const state = recordReplayDictationTranscriptState(currentSource);
  if (state.kind === "patched") return currentSource;
  if (state.kind === "current") return currentSource.slice(0, state.module.start) + state.patchedBody + currentSource.slice(state.module.end);
  if (!currentSource.includes("global-dictation-record-history-item") && !dictationCaptureClaims(currentSource).length) return currentSource;
  warn(state.reason ?? "Could not find complete native dictation producer", "Record & Replay dictation transcript patch");
  return currentSource;
}

function dictationAssetNames(extractedDir) {
  const base = path.join(extractedDir, "webview", "assets"), names = [];
  if (!fs.lstatSync(extractedDir).isDirectory() || !fs.lstatSync(path.join(extractedDir, "webview")).isDirectory()) throw Error("Dictation inventory root path is not regular");
  function visit(directory, prefix) {
    if (!fs.lstatSync(directory).isDirectory()) throw Error("Dictation inventory directory is not regular");
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = prefix + name, stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error("Dictation inventory contains a symlink");
      if (stat.isDirectory()) visit(file, relative + "/");
      else if (stat.isFile() && /\.(?:c|m)?js$/u.test(name)) names.push(relative);
    }
  }
  visit(base, "");
  return names;
}

function applyRecordReplayDictationToExtractedApp(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const hash = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  let names, hashes, edits;
  try {
    names = dictationAssetNames(extractedDir); hashes = new Map();
    const claimed = [], proofs = new Map();
    for (const name of names) {
      const source = fs.readFileSync(path.join(assets, name), "utf8");
      hashes.set(name, hash(source));
      if (dictationCaptureClaims(source).length) claimed.push(name);
    }
    const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
    const copies = findUniqueRspackModuleCopies(assets, {
      pattern: /\.(?:c|m)?js$/u,
      description: "published native ordinary dictation hook",
      sourceMatch: source => source.includes("global-dictation-record-history-item") && source.includes("transcript_dispatched"),
      matchModule: (_body, module) => {
        const state = recordReplayDictationTranscriptState(module.source);
        if (!["current", "patched"].includes(state.kind) || state.module.moduleId !== module.moduleId) return false;
        proofs.set(module.assetName, { source: module.source, state });
        return true;
      },
    });
    if (!copies.length) throw Error("Missing native ordinary dictation module cohort");
    const states = copies.map(copy => {
      if (hash(copy.source) !== hashes.get(copy.assetName)) throw Error("Dictation source changed during qualification");
      const proof = proofs.get(copy.assetName);
      const state = proof?.source === copy.source ? proof.state : recordReplayDictationTranscriptState(copy.source);
      if (!["current", "patched"].includes(state.kind) || state.module.moduleId !== copy.moduleId) throw Error(state.reason ?? "Malformed native dictation module peer");
      return { copy, state };
    });
    if (new Set(states.map(row => row.state.kind)).size !== 1) throw Error("Mixed raw/applied ordinary dictation cohort");
    const owners = new Set(copies.map(copy => copy.assetName));
    if (claimed.some(name => !owners.has(name))) throw Error("Orphan ordinary dictation capture contribution");
    const transaction = new Map();
    for (const { copy, state } of states) {
      const patchedSource = state.kind === "patched" ? copy.source : copy.source.slice(0, state.module.start) + state.patchedBody + copy.source.slice(state.module.end);
      const poststate = recordReplayDictationTranscriptState(patchedSource);
      if (poststate.kind !== "patched" || poststate.module.moduleId !== copy.moduleId) throw Error(poststate.reason ?? "Generated ordinary dictation contribution is incomplete");
      transaction.set(copy.assetName, { assetName: copy.assetName, source: copy.source, patchedSource });
      const lexical = createJavaScriptLexicalIndex(copy.source);
      for (const imported of copy.source.matchAll(/\bimport(?:\*as\s+[\w$]+|\{[^}]+\})\s+from\s*["']([^"'\n]+)["'];/gu)) {
        if (!lexical.isRoot(imported.index)) continue;
        if (!/^\.{1,2}\/[A-Za-z0-9_./-]+\.(?:c|m)?js$/u.test(imported[1])) throw Error("Unsupported dictation chunk static import edge");
        const name = path.posix.normalize(path.posix.join(path.posix.dirname(copy.assetName), imported[1]));
        if (!names.includes(name)) throw Error("Missing dictation static import dependency");
        if (!transaction.has(name)) {
          const source = fs.readFileSync(path.join(assets, name), "utf8");
          if (hash(source) !== hashes.get(name)) throw Error("Dictation import changed during qualification");
          transaction.set(name, { assetName: name, source, patchedSource: source });
        }
      }
    }
    edits = [...transaction.values()];
  } catch (error) {
    warn(error.message, "Record & Replay dictation transcript patch");
    return { matched: 0, changed: 0, changedAssets: [], reason: error.message };
  }
  const verify = () => {
    if (JSON.stringify(dictationAssetNames(extractedDir)) !== JSON.stringify(names)) throw Error("Dictation inventory changed before commit");
    for (const [name, digest] of hashes) if (hash(fs.readFileSync(path.join(assets, name))) !== digest) throw Error("Dictation read dependency changed before commit: " + name);
  };
  verify();
  const originals = new Map(edits.map(edit => [path.join(assets, edit.assetName), Buffer.from(edit.source)]));
  const result = patchWebviewAssets(assets, edits, { writeFileSync(file, bytes) {
    const restoring = originals.get(file)?.equals(bytes);
    if (!restoring) verify();
    fs.writeFileSync(file, bytes);
    if (!restoring) {
      hashes.set(path.relative(assets, file).split(path.sep).join("/"), hash(bytes));
      verify();
    }
  } });
  if (result.changed === 0) verify();
  return { matched: 1, ...result };
}

function hasRecordReplayDictationTranscriptContract(source) {
  if (typeof source !== "string") {
    return false;
  }
  const state = recordReplayDictationTranscriptState(source);
  return ["current", "patched"].includes(state.kind);
}

function recordReplayCompiledGlobalDictationPattern() {
  const id = String.raw`[A-Za-z_$][\w$]*`;
  return new RegExp(
    String.raw`(?<![\w$.])(?<dispatch>${id}(?:\.${id})*)\.dispatchMessage\("global-dictation-completed",\{sessionId:(?<session>${id})\.sessionId,text:(?<transcript>${id})\}\),(?<suffix>\k<session>\.analytics\.performance\.mark\("transcript_dispatched"\))`,
    "",
  );
}

function applyRecordReplayGlobalDictationTranscriptPatch(currentSource) {
  const patchName = "Record & Replay global dictation transcript patch";
  if (currentSource.includes("codex-linux-record-replay-global-dictation")) {
    return currentSource;
  }
  if (!currentSource.includes("global-dictation-completed")) {
    return currentSource;
  }

  const compiledCompletedPattern = recordReplayCompiledGlobalDictationPattern();
  if (compiledCompletedPattern.test(currentSource)) {
    return currentSource.replace(
      compiledCompletedPattern,
      (...args) => {
        const { dispatch, session, transcript, suffix } = args.at(-1);
        // Parenthesized: upstream dispatches from the else branch of a recovery
        // ternary, so the extra fetch must stay inside that branch.
        return `(${recordReplayActiveSpeechContextExpression(dispatch, transcript)},${dispatch}.dispatchMessage("global-dictation-completed",{sessionId:${session}.sessionId,text:${transcript}})),${suffix}`;
      },
    );
  }

  warn("Could not find global dictation completion point", patchName);
  return currentSource;
}

const descriptors = [
  {
    id: "record-and-replay-plugin-gate",
    phase: "extracted-app:pre-webview",
    order: 150,
    ciPolicy: "optional",
    apply: applyRecordReplayPluginGateToExtractedApp,
  },
  {
    id: "linux-record-replay-main-bridge",
    phase: "extracted-app:pre-webview",
    order: 152,
    apply: applyRecordReplayToExtractedApp,
  },
  {
    id: "record-replay-hud",
    phase: "extracted-app:pre-webview",
    order: 153,
    ciPolicy: "optional",
    // rspack webview runtime entries (main and detached windows); the HUD
    // runtime itself stays inert outside the main window.
    assetNeedles: ["codex-host-chunked-message-v1", "as __webpack_require__}"],
    missingDescription: "rspack webview runtime entry",
    skipDescription: "Record & Replay HUD runtime patch",
    apply: applyRecordReplayHudToExtractedApp,
    status: result => result?.matched !== 1
      ? { status: "skipped-optional", reason: result?.reason ?? "missing complete HUD entry cohort" }
      : result.changed > 0 ? "applied" : "already-applied",
  },
  {
    id: "record-replay-dictation-transcript",
    phase: "extracted-app:pre-webview",
    order: 20695,
    ciPolicy: "optional",
    assetNeedles: ["global-dictation-record-history-item", "transcript_dispatched"],
    assetMatch: hasRecordReplayDictationTranscriptContract,
    missingDescription: "composer dictation bundle",
    skipDescription: "Record & Replay dictation transcript patch",
    apply: applyRecordReplayDictationToExtractedApp,
    status: result => result?.matched !== 1
      ? { status: "skipped-optional", reason: result?.reason ?? "missing complete ordinary dictation cohort" }
      : result.changed > 0 ? "applied" : "already-applied",
  },
  {
    id: "record-replay-global-dictation-transcript",
    phase: "webview-asset",
    order: 20696,
    ciPolicy: "optional",
    assetNeedles: ["global-dictation-completed", "transcript_dispatched"],
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
  applyRecordReplayPluginGateToExtractedApp,
  applyRecordReplayHudPatch,
  applyRecordReplayMainBridgePatch,
  applyRecordReplayToExtractedApp,
  inspectRecordReplayMainBridge,
  recordReplayMainBridgeRegistration,
  descriptors,
  recordReplayBridgeSource,
  recordReplayHudRuntimeSource,
  recordReplayHelperSource,
};
