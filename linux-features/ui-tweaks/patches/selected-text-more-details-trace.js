"use strict";

const NATIVE_TRACE_MARKER = "codex-linux-selected-text-more-details:native-trace";
const IDENT = "[A-Za-z_$][\\w$]*";
const TRACE = "codexLinuxQuickChatNativeTrace";
const WRAP = "codexLinuxQuickChatTraceCallback";
const CALLBACKS = {
  onPrepareRequestStart: "prepare-request-start",
  onRequestStart: "request-start",
  onResponse: "response-headers",
  onTiming: "timing",
  onStreamData: "stream-data",
  onComplete: "stream-complete",
  onTransportClose: "transport-close",
  onError: "stream-error",
  onRecoverableError: "recoverable-error",
};

function unique(source, expression, label) {
  const matches = [...source.matchAll(new RegExp(expression, "gu"))];
  if (matches.length !== 1) throw new Error(`Expected one ${label}, found ${matches.length}`);
  return matches[0];
}

// These callback options contain nested arrow bodies. Stop only at an object
// property separator, preserving the original callback expression verbatim.
function properties(source) {
  const result = new Map();
  let cursor = 1;
  while (cursor < source.length - 1) {
    const key = /^([A-Za-z_$][\w$]*):/u.exec(source.slice(cursor));
    if (key == null || result.has(key[1])) throw new Error("Unknown native stream option shape");
    const start = cursor + key[0].length;
    let quote = null;
    let escaped = false;
    let depth = 0;
    cursor = start;
    for (; cursor < source.length - 1; cursor += 1) {
      const char = source[cursor];
      if (quote != null) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (["'", '"', "`"].includes(char)) quote = char;
      else if (["(", "[", "{"].includes(char)) depth += 1;
      else if ([")", "]", "}"].includes(char)) depth -= 1;
      else if (char === "," && depth === 0) break;
    }
    if (depth !== 0 || quote != null) throw new Error("Unbalanced native stream callback");
    result.set(key[1], { start, end: cursor, value: source.slice(start, cursor) });
    cursor += 1;
  }
  return result;
}

function patchNativeSenderTrace(dispatch) {
  const { findMatchingBrace } = require("../../../scripts/patches/lib/minified-js.js");
  const source = dispatch.source;
  const header = unique(source, `^async function ${dispatch.name.replace(/\$/gu, "\\$")}\\((${IDENT}),(${IDENT})\\)\\{`, "native sender header");
  const call = unique(source, `let (${IDENT})=await (${IDENT})\\.get\\(${IDENT}\\)\\.startCompletionStream\\(\\{assertRequestCurrent:`, "native completion stream call");
  if (call[2] !== header[1]) throw new Error("Native stream scope changed");
  const optionsStart = call.index + call[0].indexOf("{assertRequestCurrent:");
  const optionsEnd = findMatchingBrace(source, optionsStart);
  if (optionsEnd < 0) throw new Error("Missing native stream options");
  const options = source.slice(optionsStart, optionsEnd + 1);
  const fields = properties(options);
  const marked = source.includes(NATIVE_TRACE_MARKER);
  const pending = unique(options, `inFlightPrepared:(${IDENT})\\.inFlightPrepared`, "native prepared cache")[1];
  const setup = `/*${NATIVE_TRACE_MARKER}*/const ${TRACE}=codexLinuxQuickChatTraceFor(${header[1]},${header[2]}.conversationId);${TRACE}?.event("native-sender-entered");`;
  const creating = `${TRACE}?.event("native-stream-create",{cacheStatus:${pending}.cacheStatus,prepareState:${pending}.clientPrepareState,preparePending:${pending}.inFlightPrepared!=null});`;
  const edits = [];
  for (const [key, phase] of Object.entries(CALLBACKS)) {
    const field = fields.get(key);
    if (field == null) throw new Error(`Missing native ${key} callback`);
    const prefix = `${WRAP}(${TRACE},${JSON.stringify(phase)},`;
    if (marked) {
      if (!field.value.startsWith(prefix) || !field.value.endsWith(")")) throw new Error(`Incomplete native ${key} trace`);
    } else {
      edits.push({ start: optionsStart + field.start, end: optionsStart + field.end,
        value: prefix + field.value + ")" });
    }
  }
  const messages = [...source.matchAll(new RegExp(`(${IDENT})\\.onModelMessage\\((${IDENT}(?:\\.${IDENT})*)\\)`, "gu"))];
  if (messages.length !== 2) throw new Error("Native model-message hooks changed");
  for (const match of messages) {
    const wrapped = `(${TRACE}?.modelMessage(${match[2]}),${match[0]})`;
    if (marked) {
      if (!source.includes(wrapped)) throw new Error("Incomplete native model-message trace");
    } else edits.push({ start: match.index, end: match.index + match[0].length, value: wrapped });
  }
  if (marked) {
    if (source.split(NATIVE_TRACE_MARKER).length !== 2 || !source.includes(setup) ||
        !source.includes(creating + call[0])) throw new Error("Incomplete native sender trace");
    return { source, applied: true };
  }
  if (source.includes(TRACE) || source.includes(WRAP)) throw new Error("Mixed native sender trace");
  edits.push({ start: header[0].length, end: header[0].length, value: setup });
  edits.push({ start: call.index, end: call.index, value: creating });
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return { source: result, applied: false };
}

function traceRuntimeSource() {
  return `
var codexLinuxQuickChatTraces = new WeakMap();
let codexLinuxQuickChatTraceSequence = 0;
function codexLinuxQuickChatTraceFor(scope, conversationId) {
  return codexLinuxQuickChatTraces?.get(scope)?.get(conversationId);
}
function codexLinuxQuickChatAttachTrace(scope, conversationId, trace) {
  let traces=codexLinuxQuickChatTraces.get(scope);
  if(traces==null){traces=new Map();codexLinuxQuickChatTraces.set(scope,traces);}
  traces.set(conversationId,trace);
  return()=>{if(traces.get(conversationId)===trace)traces.delete(conversationId);if(traces.size===0&&codexLinuxQuickChatTraces.get(scope)===traces)codexLinuxQuickChatTraces.delete(scope);};
}
function codexLinuxQuickChatCreateTrace(logger) {
  const traceNo=++codexLinuxQuickChatTraceSequence,startedAt=Date.now(),seen=new Set(),timingCounts=new Map();
  let events=0;
  const event=(phase,fields={})=>{
    try{
      if(events++>=48)return;
      const safe={traceNo,phase,elapsedMs:Math.max(0,Date.now()-startedAt)};
      for(const key of ["durationMs","httpStatus","eventCount","eventBytes"]){const value=fields[key];if(typeof value==="number"&&Number.isFinite(value)&&value>=0)safe[key]=Math.round(value);}
      for(const key of ["capable","loading","error","preparePending","isEventStream","hasConduitToken","hadPreviousConduitToken","queuedBehindOther","errorCodePresent"]){if(typeof fields[key]==="boolean")safe[key]=fields[key];}
      for(const [key,allowed] of [["cacheStatus",["missing","pending","scheduled","hit","in_flight"]],["prepareState",["none","sent","success","failure"]],["timingType",["integrity_prepare","conversation_prepare","stream_post"]],["headerSource",["stream_unprepared","prepared_in_flight","prepared"]],["reason",["done","eof","aborted","completed","interrupted","failed"]],["channel",["analysis","final","commentary"]]]){if(allowed.includes(fields[key]))safe[key]=fields[key];}
      logger?.info("[ui-tweaks] selected-text More details action",{safe,sensitive:{}});
    }catch{}
  };
  const once=(phase,fields)=>{if(!seen.has(phase)){seen.add(phase);event(phase,fields);}};
  return{event,modelMessage(message){try{if(message?.author?.role==="assistant")once("model-message-first",{channel:message.channel});}catch{}},callback(phase,value){
    try{
      if(phase==="timing"){
        const type=value?.type;if(!["integrity_prepare","conversation_prepare","stream_post"].includes(type))return;
        const count=timingCounts.get(type)??0;if(count>=4)return;timingCounts.set(type,count+1);
        event("native-timing",{timingType:type,durationMs:value.durationMs,headerSource:value.headerSource,hasConduitToken:value.hasConduitToken,hadPreviousConduitToken:value.hadPreviousConduitToken});
      }else if(phase==="stream-data")once("stream-data-first",{eventBytes:value?.eventBytes,eventCount:value?.eventCount});
      else if(phase==="response-headers")event(phase,{httpStatus:value?.status,isEventStream:value?.isEventStream});
      else if(phase==="stream-complete")once(phase,{reason:value?.reason});
      else if(phase==="stream-error"||phase==="recoverable-error")event(phase,{errorCodePresent:value?.errorCode!=null,httpStatus:value?.responseStatus});
      else event(phase);
    }catch{}
  }};
}
function codexLinuxQuickChatTraceCallback(trace,phase,callback) {
  if(trace==null)return callback;
  return function(...args){trace.callback(phase,args[0]);return typeof callback==="function"?Reflect.apply(callback,this,args):void 0;};
}
`;
}

module.exports = { NATIVE_TRACE_MARKER, patchNativeSenderTrace, traceRuntimeSource };
