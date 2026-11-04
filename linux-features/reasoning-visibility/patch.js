"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { withRuntime } = require("./runtime.js");
const { settingsDescriptor } = require("./settings.js");
const { persistentDescriptor: persistent } = require("./persistent.js");
const { requestSummariesDescriptor: summaries } = require("./request-summaries.js");
const { standaloneDescriptor: standalone, applyStandalonePatch } = require("./standalone.js");
const { transcriptDescriptor: transcript, applyTranscriptPatch } = require("./transcript.js");

const ident = String.raw`[A-Za-z_$][\w$]*`;
const marker = (id) => `/*community-reasoning-visibility-${id}*/`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const enabled = "codexLinuxReasoningVisibilityEnabled()";
const enabledPattern = escape(enabled);

function reasoningComponent(source) {
  const keys = [...source.matchAll(/key:"reasoning-markdown"/g)];
  if (keys.length !== 1) return null;
  const headers = [...source.slice(0, keys[0].index).matchAll(new RegExp(String.raw`function ${ident}\(${ident}\)\{`, "g"))];
  const header = headers.at(-1);
  if (header == null) return null;
  const end = findMatchingBrace(source, header.index + header[0].length - 1);
  if (end < keys[0].index) return null;
  const text = source.slice(header.index, end + 1);
  // Bind this state to the completed reasoning body and native disclosure.
  const pattern = new RegExp(
    String.raw`\[(?<state>${ident}),(?<setter>${ident})\]=\(0,(?<react>${ident})\.useState\)\((?:!1|${enabledPattern}${escape(marker("expanded"))})\),(?<disclosure>${ident})=!(?<stream>${ident})&&!!(?<body>${ident})[,;]`, "g",
  );
  const states = [...text.matchAll(pattern)];
  if (states.length !== 1) return null;
  const state = states[0];
  const { stream, body, state: expanded, setter } = state.groups;
  if (!text.includes(`:${expanded},`) || !text.includes(`expanded:${expanded},onToggle:()=>{${setter}(`) ||
      !text.includes(`autoScrollToBottom:${stream},`) ||
      (!text.includes(`?${body}`) && !text.includes(`:${body},`) && !text.includes(`:${body};`))) return null;
  return { start: header.index, text, state };
}

function applyExpandedPatch(source) {
  const component = reasoningComponent(source);
  if (component == null) {
    console.warn("WARN: reasoning-visibility/expanded: current reasoning disclosure contract missing or ambiguous; disable this feature and rebuild or update its patch.");
    return source;
  }
  const { state, text, start } = component;
  const replacement = state[0].replace(new RegExp(String.raw`\(!1\)|\(${enabledPattern}${escape(marker("expanded"))}\)`), `(${enabled}${marker("expanded")})`);
  const next = text.slice(0, state.index) + replacement + text.slice(state.index + state[0].length);
  return withRuntime(source.slice(0, start) + next + source.slice(start + text.length));
}

module.exports = {
  applyStandalonePatch,
  applyTranscriptPatch,
  reasoningComponent,
  descriptors: [standalone, persistent, transcript, summaries, {
    id: "expanded",
    phase: "webview-asset",
    order: 20_746,
    ciPolicy: "optional",
    assetNeedles: ['key:"reasoning-markdown"'],
    missingDescription: "reasoning markdown disclosure component",
    apply: applyExpandedPatch,
  }, settingsDescriptor],
};
