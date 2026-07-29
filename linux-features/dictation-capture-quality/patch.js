"use strict";

const {
  findMatchingBrace,
  requireName,
} = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";
const HANDLER_NAME = "linux-openai-dictation-transcribe";
const SECRET_SERVICE = "codex-desktop-openai-transcription";
const CAPTURE_MARKER = "codexLinuxDictationCaptureQuality";
const RENDERER_MARKER = "codexLinuxOpenAITranscription";
const STREAMING_MARKER = "codexLinuxDictationBatchOnly";
const MAIN_HANDLER_MARKER = `"${HANDLER_NAME}":async`;
const MAIN_COMPLETION_MARKER = "codexLinuxOpenAITranscriptionMainComplete";
const CURRENT_APP_INITIAL_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const OPENWHISPR_CONSTRAINTS =
  "channelCount:2,echoCancellation:!1,noiseSuppression:!1,autoGainControl:!1";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_AUDIO_BYTES / 3) * 4;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function matches(source, pattern) {
  return [...source.matchAll(new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  ))];
}

function countLiteral(source, literal) {
  return source.split(literal).length - 1;
}

function applyEdits(source, edits) {
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        `${current.slice(0, edit.start)}${edit.replacement}${current.slice(edit.end)}`,
      source,
    );
}

function resolveFallbackFunction(source) {
  const startPattern = new RegExp(
    `async function (${IDENT})\\(e,t=\\{\\}\\)\\{`,
    "g",
  );
  const candidates = [];

  for (const match of matches(source, startPattern)) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex === -1) {
      continue;
    }
    const body = source.slice(match.index, closeIndex + 1);
    if (
      !body.includes("post(`/transcribe`") ||
      !body.includes("audio/webm")
    ) {
      continue;
    }
    const clientMatch = body.match(
      /([A-Za-z_$][\w$]*)\.getInstance\(\)\.post\(`\/transcribe`/u,
    );
    const base64Match = body.match(
      /=([A-Za-z_$][\w$]*)\(await [A-Za-z_$][\w$]*\(\{blob:e,/u,
    );
    if (clientMatch == null || base64Match == null) {
      continue;
    }
    candidates.push({
      start: match.index,
      end: closeIndex + 1,
      functionName: match[1],
      clientVar: clientMatch[1],
      base64Var: base64Match[1],
    });
  }

  return candidates;
}

function rendererFallbackSource({ functionName, clientVar, base64Var }) {
  return [
    `async function ${functionName}(e,t={}){`,
    "if(e==null||typeof e.arrayBuffer!==`function`||",
    "!Number.isSafeInteger(e.size)||",
    `e.size<=0||e.size>${MAX_AUDIO_BYTES})`,
    "throw Error(`Dictation audio is invalid or too large.`);",
    "let __codexContentType=t.contentType??",
    "(e.type&&e.type.trim().length>0?e.type:`audio/webm`),",
    `__codexAudioBase64=${base64Var}(new Uint8Array(await e.arrayBuffer()));`,
    `return(await ${clientVar}.getInstance().post(`,
    `\`vscode://codex/${HANDLER_NAME}\`,`,
    "JSON.stringify({audioBase64:__codexAudioBase64,contentType:__codexContentType}),",
    "{})).body.text",
    `/*${RENDERER_MARKER}*/`,
    "}",
  ].join("");
}

function applyDictationCaptureQualityPatch(source) {
  const patchName = "dictation capture and OpenAI transcription webview patch";
  if (
    !source.includes("global-dictation-record-history-item") ||
    !source.includes("new MediaRecorder") ||
    !source.includes("dictation-stream-connect-info")
  ) {
    warn("Could not resolve the current composer dictation contract", patchName);
    return source;
  }

  const patchedConstraint =
    `${OPENWHISPR_CONSTRAINTS}/*${CAPTURE_MARKER}*/`;
  const patchedStreaming = `streamingEnabled:!1/*${STREAMING_MARKER}*/`;
  const handlerRoute = `vscode://codex/${HANDLER_NAME}`;
  const hasCapturePatch = source.includes(patchedConstraint);
  const hasCaptureMarker = source.includes(CAPTURE_MARKER);
  const hasRendererPatch =
    source.includes(handlerRoute) && source.includes(RENDERER_MARKER);
  const hasRendererMarker = source.includes(RENDERER_MARKER);
  const hasStreamingPatch = source.includes(patchedStreaming);
  const hasStreamingMarker = source.includes(STREAMING_MARKER);

  if (hasCapturePatch && hasRendererPatch && hasStreamingPatch) {
    return source;
  }
  if (
    hasCaptureMarker !== hasCapturePatch ||
    hasRendererMarker !== hasRendererPatch ||
    hasStreamingMarker !== hasStreamingPatch
  ) {
    warn("Found an incomplete dictation transcription patch", patchName);
    return source;
  }

  const edits = [];

  if (!hasCapturePatch) {
    const constraintPattern = new RegExp(
      `stream:(${IDENT})\\(\\{channelCount:1\\}\\)\\.then\\(`,
      "g",
    );
    const constraintMatches = matches(source, constraintPattern);
    if (constraintMatches.length !== 1) {
      warn(
        `Expected one composer microphone constraint, found ${constraintMatches.length}`,
        patchName,
      );
      return source;
    }
    const match = constraintMatches[0];
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: `stream:${match[1]}({${patchedConstraint}}).then(`,
    });
  }

  if (!hasRendererPatch) {
    const fallbacks = resolveFallbackFunction(source);
    if (fallbacks.length !== 1) {
      warn(
        `Expected one multipart transcription fallback, found ${fallbacks.length}`,
        patchName,
      );
      return source;
    }
    const fallback = fallbacks[0];
    edits.push({
      start: fallback.start,
      end: fallback.end,
      replacement: rendererFallbackSource(fallback),
    });
  }

  if (!hasStreamingPatch) {
    const streamingPattern = new RegExp(
      `cleanupEnabled:!1,streamingEnabled:(${IDENT})(?=[,}])`,
      "g",
    );
    const streamingMatches = matches(source, streamingPattern);
    if (streamingMatches.length !== 1) {
      warn(
        `Expected one composer streaming flag, found ${streamingMatches.length}`,
        patchName,
      );
      return source;
    }
    const match = streamingMatches[0];
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: `cleanupEnabled:!1,${patchedStreaming}`,
    });
  }

  return applyEdits(source, edits);
}

function dictationMainHandlerSource({ electronVar }) {
  return [
    `"${HANDLER_NAME}":async({audioBase64:__codexAudioBase64,`,
    "contentType:__codexContentType,origin:__codexOrigin,",
    "signal:__codexCallerSignal}={})=>{",
    "if(!this.windowManager?.getPrimaryWindows?.().some(",
    "__codexWindow=>__codexWindow.webContents===__codexOrigin))",
    "throw Error(`Dictation transcription is unavailable from this window.`);",
    "if(typeof __codexAudioBase64!==`string`||",
    `__codexAudioBase64.length===0||__codexAudioBase64.length>${MAX_BASE64_LENGTH}||`,
    "__codexAudioBase64.length%4!==0)",
    "throw Error(`Dictation audio is invalid or too large.`);",
    "let __codexMime=String(__codexContentType??``).toLowerCase().replace(/\\s+/g,``);",
    "if(__codexMime!==`audio/webm`&&__codexMime!==`audio/webm;codecs=opus`)",
    "throw Error(`Dictation audio must be WebM/Opus.`);",
    "if(this.__codexOpenAITranscriptionActive===!0)",
    "throw Error(`A dictation transcription is already in progress.`);",
    "this.__codexOpenAITranscriptionActive=!0;",
    "let __codexAudio=null,__codexSecret=null,__codexApiKey=``;",
    "try{",
    "__codexAudio=Buffer.from(__codexAudioBase64,`base64`);",
    "if(__codexAudio.length===0||",
    `__codexAudio.length>${MAX_AUDIO_BYTES}||`,
    "__codexAudio.toString(`base64`)!==__codexAudioBase64||",
    "__codexAudio.length<4||__codexAudio[0]!==26||__codexAudio[1]!==69||",
    "__codexAudio[2]!==223||__codexAudio[3]!==163)",
    "throw Error(`Dictation audio is invalid or too large.`);",
    "__codexCallerSignal?.throwIfAborted?.();",
    "__codexSecret=await new Promise((__codexResolve,__codexReject)=>{",
    "require(`node:child_process`).execFile(`/usr/bin/secret-tool`,",
    `[\`lookup\`,\`service\`,\`${SECRET_SERVICE}\`],`,
    "{encoding:null,timeout:5e3,maxBuffer:4096},",
    "(__codexError,__codexStdout)=>{",
    "if(__codexError){__codexReject(Error(`Codex OpenAI transcription key is unavailable.`));return}",
    "__codexResolve(Buffer.isBuffer(__codexStdout)?__codexStdout:Buffer.from(__codexStdout??``))",
    "})});",
    "__codexCallerSignal?.throwIfAborted?.();",
    "let __codexKeyEnd=__codexSecret.length;",
    "while(__codexKeyEnd>0&&(__codexSecret[__codexKeyEnd-1]===10||",
    "__codexSecret[__codexKeyEnd-1]===13))__codexKeyEnd--;",
    "if(__codexKeyEnd<20)throw Error(`Codex OpenAI transcription key is unavailable.`);",
    "__codexApiKey=__codexSecret.subarray(0,__codexKeyEnd).toString(`utf8`);",
    "let __codexForm=new FormData;",
    "__codexForm.append(`file`,new Blob([__codexAudio],{type:`audio/webm`}),`codex.webm`);",
    "__codexForm.append(`model`,`gpt-4o-transcribe`);",
    "__codexForm.append(`language`,`en`);",
    "let __codexTimeoutSignal=AbortSignal.timeout(12e4),",
    "__codexRequestSignal=__codexCallerSignal&&typeof AbortSignal.any===`function`?",
    "AbortSignal.any([__codexCallerSignal,__codexTimeoutSignal]):__codexTimeoutSignal,",
    `__codexResponse=await ${electronVar}.net.fetch(`,
    "`https://api.openai.com/v1/audio/transcriptions`,",
    "{method:`POST`,headers:{Authorization:`Bearer ${__codexApiKey}`},",
    "body:__codexForm,signal:__codexRequestSignal});",
    "if(!__codexResponse.ok){",
    "try{await __codexResponse.body?.cancel()}catch{}",
    "throw Error(`OpenAI transcription failed (${__codexResponse.status}).`)}",
    "let __codexPayload;",
    "try{__codexPayload=await __codexResponse.json()}",
    "catch{throw Error(`OpenAI transcription returned invalid JSON.`)}",
    "if(typeof __codexPayload?.text!==`string`)",
    "throw Error(`OpenAI transcription response did not contain text.`);",
    `return{text:__codexPayload.text}/*${RENDERER_MARKER}*/`,
    "}finally{",
    "this.__codexOpenAITranscriptionActive=!1;",
    "__codexAudio?.fill(0);__codexSecret?.fill(0);__codexApiKey=``",
    `}}/*${MAIN_COMPLETION_MARKER}*/`,
  ].join("");
}

function applyDictationMainBridgePatch(source) {
  const patchName = "dictation OpenAI main-process bridge patch";
  const hasHandler = source.includes(MAIN_HANDLER_MARKER);
  const hasCompletionMarker = source.includes(MAIN_COMPLETION_MARKER);
  if (hasHandler && hasCompletionMarker) {
    return source;
  }
  if (hasHandler !== hasCompletionMarker) {
    warn("Found an incomplete dictation main-process bridge", patchName);
    return source;
  }

  const electronVar = requireName(source, "electron");
  if (electronVar == null) {
    warn("Could not find the Electron main-process module alias", patchName);
    return source;
  }

  const anchor = `"native-desktop-apps":async`;
  const anchorCount = countLiteral(source, anchor);
  if (anchorCount !== 1) {
    warn(
      `Expected one trusted handler insertion point, found ${anchorCount}`,
      patchName,
    );
    return source;
  }

  return source.replace(
    anchor,
    `${dictationMainHandlerSource({ electronVar })},${anchor}`,
  );
}

const descriptors = [
  {
    id: "dictation-openai-main-bridge",
    phase: "main-bundle",
    order: 20_684,
    ciPolicy: "optional",
    apply: applyDictationMainBridgePatch,
  },
  {
    id: "composer-dictation-capture-quality",
    phase: "webview-asset",
    order: 20_685,
    ciPolicy: "optional",
    pattern: CURRENT_APP_INITIAL_ASSET_PATTERN,
    missingDescription: "current primary dictation bundle",
    skipDescription: "dictation capture and OpenAI transcription patch",
    apply: applyDictationCaptureQualityPatch,
  },
];

module.exports = {
  HANDLER_NAME,
  MAX_AUDIO_BYTES,
  SECRET_SERVICE,
  applyDictationCaptureQualityPatch,
  applyDictationMainBridgePatch,
  descriptors,
  dictationMainHandlerSource,
};
