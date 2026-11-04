"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ARGUMENT = "--codex-community-new-window";
const MARKER = "/* codex-linux-desktop-new-window */";
const ID = "[A-Za-z_$][\\w$]*";

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function applyNewWindowPatch(source) {
  const drift = () => {
    console.warn("WARN: New Window desktop action could not identify the upstream window activation handler");
    return source;
  };
  const registration = uniqueMatch(source, new RegExp(`\\bsetSecondInstanceArgsHandler:(${ID})(?=[,}])`, "g"));
  const windowCallbacks = uniqueMatch(source, new RegExp(
    `\\bwindowServices:(${ID}),createFreshWindow:(${ID}),ensureWindow:${ID},` +
    `getElectronMessageHandlerForWindow:${ID}\\.getElectronMessageHandlerForWindow\\b`, "g",
  ));
  if (!registration || !windowCallbacks) return drift();

  const [, windowServices, createFreshWindow] = windowCallbacks;
  const createCall = uniqueMatch(source, new RegExp(
    `(?:^|[\\s,;])${escapeRegExp(createFreshWindow)}=async\\((${ID}),(${ID})\\)=>\\{` +
    `[^{}]{0,240}?\\bawait ${escapeRegExp(windowServices)}\\.createFreshWindow\\(\\1,\\2\\)`, "g",
  ));
  const handler = uniqueMatch(source, new RegExp(
    `\\.onInteractiveLaunch=null,${escapeRegExp(registration[1])}\\((${ID})=>\\{`, "g",
  ));
  if (!handler || !createCall || registration.index >= createCall.index ||
      createCall.index >= windowCallbacks.index || windowCallbacks.index >= handler.index) return drift();

  const insertAt = handler.index + handler[0].length;
  const handlerEnd = findMatchingBrace(source, insertAt - 1);
  const args = escapeRegExp(handler[1]);
  const body = handlerEnd === -1 ? "" : source.slice(insertAt, handlerEnd);
  if (!uniqueMatch(body, new RegExp(`\\.deepLinks\\.queueProcessArgs\\(${args}\\)`, "g"))) return drift();

  // Upstream queues requests that arrive before it installs this handler.
  const branch = MARKER +
    `if(process.platform==="linux"&&${handler[1]}.includes(${JSON.stringify(ARGUMENT)})){` +
    `void ${createFreshWindow}("/").catch(error=>console.warn("[desktop-new-window] Could not open window",error));return}`;
  if (body.startsWith(branch)) return source;
  if (source.includes(MARKER)) return drift();
  return source.slice(0, insertAt) + branch + source.slice(insertAt);
}

module.exports = {
  applyNewWindowPatch,
  descriptors: [{
    id: "second-instance",
    phase: "main-bundle",
    ciPolicy: "optional",
    enforceWhenEnabled: false,
    apply: applyNewWindowPatch,
  }],
};
