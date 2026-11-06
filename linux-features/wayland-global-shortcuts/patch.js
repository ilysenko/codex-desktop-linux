"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { IDENT, inspectGlobalShortcutsPortal, installPortalBackend } = require("../../scripts/patches/lib/global-shortcuts-portal.js");

const PATCH_MARKER = "codex-linux-wayland-global-shortcuts-v1";
const MARKER_NAME = "codexLinuxWaylandGlobalShortcutsPatch";
const MARKER_SOURCE = "var " + MARKER_NAME + "=" + JSON.stringify(PATCH_MARKER) + ";";
const ACTION_IDS = ["hotkeyWindow", "openAvatarOverlay", "appshots", "realtimeVoice", "meetings"];

function warn(reason) {
  console.warn("WARN: " + reason + " - skipping Wayland global shortcuts patch");
}
function one(values, description) {
  if (values.length !== 1) throw new Error(description + " matched " + values.length + " times");
  return values[0];
}
function scope(source, start, end) {
  const text = source.slice(start, end);
  return { source, start, end, text, lexical: createJavaScriptLexicalIndex(text) };
}
function matches(owner, pattern, root = true) {
  return [...owner.text.matchAll(pattern)].filter(match => owner.lexical.isCode(match.index) && (!root || owner.lexical.isRoot(match.index)));
}
function bodyAt(owner, head, description) {
  const open = head.index + head[0].length - 1;
  const close = owner.lexical.matchingBrace(open);
  if (close <= open) throw new Error(description + " has no complete body");
  return scope(owner.source, owner.start + open + 1, owner.start + close);
}
function evaluatedAt(owner, index) {
  let prefix = owner.text.slice(0, index);
  const before = scope(prefix, 0, prefix.length);
  for (const exit of matches(before, /\b(?:return|throw)\b/gu)) {
    try { new Script("async function reached(){" + prefix.slice(0, exit.index) + "\nconst reached=0;}"); return false; }
    catch { /* A conditional native exit retains the following statement. */ }
  }
  if (prefix.endsWith(",")) prefix = prefix.slice(0, -1) + ";";
  try { new Script("async function reached(){" + prefix + "\nconst reached=0;}"); return true; }
  catch { return false; }
}
function assertReadOnlyBinding(owner, name, authorizedIndex, description) {
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu;
  for (const token of owner.text.matchAll(tokens)) {
    if (!owner.lexical.isCode(token.index) || owner.text[token.index - 1] === ".") continue;
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
      (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (decoded !== name || token.index === authorizedIndex) continue;
    const parses = replacement => {
      try { new Script("async function bindingProbe(){" + owner.text.slice(0, token.index) + replacement + owner.text.slice(token.index + token[0].length) + "}"); return true; }
      catch { return false; }
    };
    if (!parses("(0)") && !parses(name + ":(0)")) throw new Error(description + " is shadowed or reassigned");
  }
}
function skipTrivia(owner, index) {
  for (;;) {
    while (/\s/u.test(owner.text[index] ?? "") && index < owner.text.length) index++;
    if (owner.text.startsWith("/*", index)) {
      const close = owner.text.indexOf("*/", index + 2);
      if (close < 0) throw new Error("Incomplete class member comment");
      index = close + 2;
    } else if (owner.text.startsWith("//", index)) {
      const line = owner.text.slice(index + 2).search(/[\r\n\u2028\u2029]/u);
      index = line < 0 ? owner.text.length : index + 2 + line;
    } else return index;
  }
}
function delimiterEnd(owner, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, stack = [];
  for (let index = open; index < owner.text.length; index++) {
    if (!owner.lexical.isCode(index)) continue;
    const character = owner.text[index];
    if (pairs[character]) stack.push(pairs[character]);
    else if (")]}".includes(character)) {
      if (stack.pop() !== character) throw new Error("Unbalanced class member expression");
      if (stack.length === 0) return index;
    }
  }
  throw new Error("Incomplete class member expression");
}
function quotedKey(owner, start) {
  const quote = owner.text[start];
  let end = start + 1;
  for (; end < owner.text.length; end++) {
    if (owner.text[end] === "\\") end++;
    else if (owner.text[end] === quote) break;
  }
  if (end >= owner.text.length) throw new Error("Incomplete quoted class member key");
  const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
  const name = owner.text.slice(start + 1, end).replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/gu,
    (_, braced, fixed, hex, escaped) => {
      if (braced || fixed || hex) return String.fromCodePoint(parseInt(braced || fixed || hex, 16));
      if (/^[\r\n\u2028\u2029]/u.test(escaped)) return "";
      return escapes[escaped] ?? escaped;
    });
  return { name, end: end + 1 };
}
function memberKey(owner, start) {
  let index = start;
  const privateKey = owner.text[index] === "#";
  if (privateKey) index++;
  if (owner.text[index] === "[") {
    const close = delimiterEnd(owner, index), literal = skipTrivia(owner, index + 1);
    if (!['"', "'"].includes(owner.text[literal])) throw new Error("Unproven computed class member key");
    const key = quotedKey(owner, literal);
    if (skipTrivia(owner, key.end) !== close) throw new Error("Unproven computed class member expression");
    return { name: key.name, end: close + 1, privateKey };
  }
  if (['"', "'"].includes(owner.text[index])) return { ...quotedKey(owner, index), privateKey };
  const identifier = /^(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/u.exec(owner.text.slice(index));
  if (!identifier) throw new Error("Unsupported class member key");
  return { name: decodeUnicode(identifier[0]), end: index + identifier[0].length, privateKey };
}
function assertFieldBoundary(controller, equals, end) {
  if (controller.text[equals] !== "=") return;
  const bounded = controller.text.slice(0, equals + 1) + "(" + controller.text.slice(equals + 1, end) + "\n)" + controller.text.slice(end);
  try { new Script("class ClassFieldBoundaryProbe extends Object{" + bounded + "}"); }
  catch { throw new Error("Class field initializer has an unproven ASI boundary"); }
}
function classMembers(controller) {
  const members = [], modifiers = new Set(["static", "async", "get", "set"]);
  let index = 0;
  while ((index = skipTrivia(controller, index)) < controller.text.length) {
    if (controller.text[index] === ";") { index++; continue; }
    const kinds = [];
    if (controller.text[index] === "*") { kinds.push("generator"); index = skipTrivia(controller, index + 1); }
    let key = memberKey(controller, index), next = skipTrivia(controller, key.end);
    while (!key.privateKey && modifiers.has(key.name) && !["(", "=", ";", undefined].includes(controller.text[next])) {
      kinds.push(key.name);
      index = next;
      if (controller.text[index] === "*") { kinds.push("generator"); index = skipTrivia(controller, index + 1); }
      key = memberKey(controller, index);
      next = skipTrivia(controller, key.end);
    }
    if (controller.text[next] === "(") {
      const parametersEnd = delimiterEnd(controller, next), open = skipTrivia(controller, parametersEnd + 1);
      if (controller.text[open] !== "{") throw new Error("Missing class method body");
      const close = controller.lexical.matchingBrace(open);
      if (close <= open) throw new Error("Incomplete class method body");
      members.push({ ...key, kinds, kind: "method", parameters: controller.text.slice(next + 1, parametersEnd),
        body: scope(controller.source, controller.start + open + 1, controller.start + close) });
      index = close + 1;
    } else {
      if (!["=", ";", undefined].includes(controller.text[next])) throw new Error("Unsupported class field");
      members.push({ ...key, kinds, kind: "field" });
      index = next;
      while (index < controller.text.length) {
        if (controller.lexical.isCode(index) && controller.text[index] === ";") break;
        if (controller.lexical.isCode(index) && "([{".includes(controller.text[index])) index = delimiterEnd(controller, index);
        index++;
      }
      assertFieldBoundary(controller, next, index);
      index++;
    }
  }
  return members;
}
function method(controller, name) {
  const member = one(classMembers(controller).filter(member => member.name === name), name + " class member");
  if (member.kind !== "method" || member.privateKey || member.kinds.length !== 0) throw new Error(name + " changed its native public instance method kind");
  return { ...member.body, parameters: member.parameters };
}
function constructedController(factory, producer, metadata, role) {
  const binding = metadata.owner.windowServices.bindings[role];
  if (!binding) throw new Error("Missing returned " + role + " binding");
  const construction = one(matches(producer, new RegExp("(?<![\\w$.])" + escapeRegExp(binding) + "=new (" + IDENT + ")\\(", "gu")), role + " construction");
  if (!evaluatedAt(producer, construction.index)) throw new Error(role + " construction is not evaluated");
  const name = construction[1];
  try { new Script("async function shadowProbe(){" + producer.text + "\nlet " + name + ";}"); }
  catch { throw new Error(role + " constructor is shadowed in the producer"); }
  const head = one(matches(factory, new RegExp("\\bclass " + escapeRegExp(name) + "(?: extends " + IDENT + "(?:\\." + IDENT + ")?)?\\{", "gu")), role + " class");
  if (!evaluatedAt(factory, head.index)) throw new Error(role + " class is not a module declaration");
  assertReadOnlyBinding(factory, name, head.index + "class ".length, role + " class");
  assertReadOnlyBinding(producer, binding, construction.index, role + " returned binding");
  return bodyAt(factory, head, role);
}
function returnedClosure(producer, metadata, role, parameters) {
  const binding = metadata.owner.windowServices.bindings[role];
  if (!binding) throw new Error("Missing returned " + role + " binding");
  const head = one(matches(producer, new RegExp("(?<![\\w$.])" + escapeRegExp(binding) + "=function\\(\\{" + parameters + "\\}\\)\\{", "gu")), role + " closure");
  if (!evaluatedAt(producer, head.index)) throw new Error(role + " closure is not evaluated");
  const closure = bodyAt(producer, head, role);
  assertReadOnlyBinding(producer, binding, head.index, role + " returned binding");
  if (!producer.source.slice(closure.end, closure.end + 3).startsWith("}({")) throw new Error(role + " closure is not directly invoked");
  return { ...closure, parameters: head.groups };
}
function syncArrow(closure, gate, description) {
  const head = one(matches(closure, new RegExp("(" + IDENT + ")=\\(\\)=>\\{(?=" + gate + ")", "gu")), description + " sync callback");
  return { ...bodyAt(closure, head, description), name: head[1] };
}
function registration(owner, register, id, accelerator, callback, options = "", root = true) {
  const pattern = new RegExp("(?<![\\w$.])" + escapeRegExp(register) + "\\(" + accelerator + ",\\{(?:linuxCommandId:" + JSON.stringify(id) + ",)?" + callback + "\\}" + options + "\\)", "gu");
  const found = one(matches(owner, pattern, root), id + " native registration");
  if (root) {
    const prefix = scope(owner.text, 0, found.index);
    for (const exit of matches(prefix, /\b(?:return|throw)\b/gu)) {
      let unconditional = false;
      try { new Script("async function reachabilityProbe(){" + prefix.text.slice(0, exit.index) + "\nconst reached=0;}"); unconditional = true; }
      catch { /* The native conditional exit preserves this registration. */ }
      if (unconditional) throw new Error(id + " registration is unreachable");
    }
  }
  const open = found.index + found[0].indexOf(",{") + 1;
  if (owner.lexical.matchingBrace(open) < open) throw new Error(id + " callback object is incomplete");
  return { id, start: owner.start + open + 1, tagged: found[0].includes("linuxCommandId:" + JSON.stringify(id) + ",") };
}
function requireText(owner, pattern, description, root = false) {
  one(matches(owner, pattern, root), description);
}
function actionPlan(source, metadata) {
  if (!metadata.owner) throw new Error(metadata.reason || "Shared Portal owner is unavailable");
  const factory = scope(source, metadata.owner.factoryBody.start, metadata.owner.factoryBody.end);
  const producer = scope(source, metadata.owner.windowServices.body.start, metadata.owner.windowServices.body.end);
  const register = metadata.owner.registration.name;
  const electron = one([...new Set([...metadata.owner.registration.body.matchAll(/([A-Za-z_$][\w$]*)\.globalShortcut\.unregister\(/gu)].map(match => match[1]))], "native Electron shortcut binding");
  const hotkey = constructedController(factory, producer, metadata, "hotkeyWindowLifecycleManager");
  const hotkeyMethod = method(hotkey, "registerHotkeyWindowHotkeyOrThrow");
  const [accelerator, ownership] = hotkeyMethod.parameters.split(",");
  if (!new RegExp("^" + IDENT + "," + IDENT + "$", "u").test(hotkeyMethod.parameters)) throw new Error("Popout registration parameters changed");
  requireText(hotkey, /this\.configuredHotkeyWindowHotkey=([A-Za-z_$][\w$]*)\(\{keymapHotkey:([A-Za-z_$][\w$]*),legacyHotkey:([A-Za-z_$][\w$]*)\}\)/gu, "Popout preferred keymap");
  requireText(method(hotkey, "isHotkeyWindowEffectivelyEnabled"), /return!this\.isDisposed&&this\.isHotkeyWindowGateEnabled&&null!=this\.configuredHotkeyWindowHotkey&&\(!this\.isDevMode\|\|this\.devHotkeyWindowHotkeyOverrideEnabled\)/gu, "Popout availability", true);
  requireText(hotkey, /this\.registerHotkeyWindowHotkeyOrThrow\(this\.configuredHotkeyWindowHotkey,[A-Za-z_$][\w$]*\)/gu, "Popout lifecycle registration");
  const popout = registration(hotkeyMethod, register, "hotkeyWindow", escapeRegExp(accelerator), "onPressed:\\(\\)=>\\{this\\.handleHotkeyWindowHotkeyPressed\\(\\)\\}", ",\\{ownership:" + escapeRegExp(ownership) + "\\}");

  const appshot = constructedController(factory, producer, metadata, "appshotHotkeysService");
  requireText(method(appshot, "getState"), /supported:this\.enabled&&\("darwin"===process\.platform\|\|"win32"===process\.platform&&null!=this\.windowsCaptureNativeBridge&&!this\.windowsCaptureNativeBridgeFailed\)/gu, "Appshot availability");
  const appshotCall = registration(appshot, register, "appshots", "this\\.configuredHotkey", "onPressed:\\(\\)=>this\\.#[A-Za-z_$][\\w$]*\\(\\)", ',\\{bareModifierTrigger:"immediatePress"\\}', false);
  const appshotHeads = matches(appshot, /(?<![\w$.])(?:#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\([^()]*\)\{/gu);
  const appshotMethod = one(appshotHeads.map(head => bodyAt(appshot, head, "Appshot method")).filter(body => body.start <= appshotCall.start && body.end > appshotCall.start), "Appshot registration method");
  requireText(appshotMethod, /!this\.getState\(\)\.supported\|\|null==this\.configuredHotkey/gu, "Appshot registration gate");
  registration(appshotMethod, register, "appshots", "this\\.configuredHotkey", "onPressed:\\(\\)=>this\\.#[A-Za-z_$][\\w$]*\\(\\)", ',\\{bareModifierTrigger:"immediatePress"\\}');

  const pet = returnedClosure(producer, metadata, "overlayHotkeyController", "toggleAvatarOverlay:(?<toggle>" + IDENT + "),notch:(?<notch>" + IDENT + ")");
  const petSync = syncArrow(pet, "if\\(null==" + IDENT + "\\|\\|!" + IDENT + "\\(\\)\\)return void " + IDENT + "\\(\\);if\\(" + IDENT + "===" + IDENT + "\\)return;", "Pet");
  const petGate = /^if\(null==([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)\(\)\)return void ([A-Za-z_$][\w$]*)\(\);if\(([A-Za-z_$][\w$]*)===\1\)return;/u.exec(petSync.text);
  if (!petGate) throw new Error("Pet availability or registration identity changed");
  const [, petKey, available, clear] = petGate;
  requireText(pet, /commandId:"openAvatarOverlay",isMacOS:"darwin"===process\.platform/gu, "Pet preferred keymap");
  requireText(pet, /syncCommandKeybinding:[A-Za-z_$][\w$]*=>\{/gu, "Pet preference synchronization");
  requireText(pet, new RegExp(escapeRegExp(petGate[4]) + "=null,(" + IDENT + ")=null," + escapeRegExp(clear) + "=\\(\\)=>\\{\\1\\?\\.unregister\\(\\),\\1=null," + escapeRegExp(petGate[4]) + "=null\\}", "gu"), "Pet native cleanup");
  requireText(pet, new RegExp("syncCommandKeybinding:(" + IDENT + ")=>\\{null!=\\1&&\\1!==" + escapeRegExp(petKey) + "&&" + IDENT + "\\(\\1\\)," + escapeRegExp(petKey) + "=\\1;try\\{" + escapeRegExp(petSync.name) + "\\(\\)\\}", "gu"), "Pet preferred keymap consumption");
  const petCall = registration(petSync, register, "openAvatarOverlay", escapeRegExp(petKey), "onPressed:\\(\\)=>\\{" + escapeRegExp(available) + "\\(\\)\\?" + escapeRegExp(pet.parameters.toggle) + "\\(\\)\\.catch\\((?<failure>" + IDENT + ")=>\\{\\(0," + IDENT + "\\." + IDENT + "\\)\\(\\)\\.warning\\(\"Failed to toggle pet from global hotkey\",\\{safe:\\{\\},sensitive:\\{error:\\k<failure>\\}\\}\\)\\}\\):" + escapeRegExp(clear) + "\\(\\)\\}");

  const voice = returnedClosure(producer, metadata, "realtimeVoiceHotkeyController", "requestRealtimeToggle:(?<toggle>" + IDENT + "),subscribeRealtimeVoiceSessionReservation:(?<subscribe>" + IDENT + ")");
  const voiceSync = syncArrow(voice, "if\\(null==" + IDENT + "\\|\\|!" + IDENT + "\\(\\)\\.realtimeVoice&&!" + IDENT + "\\)return void " + IDENT + "\\(\\);if\\(" + IDENT + "===" + IDENT + "\\)return;", "Voice");
  const voiceGate = /^if\(null==([A-Za-z_$][\w$]*)\|\|![A-Za-z_$][\w$]*\(\)\.realtimeVoice&&!([A-Za-z_$][\w$]*)\)return void [A-Za-z_$][\w$]*\(\);if\([A-Za-z_$][\w$]*===\1\)return;/u.exec(voiceSync.text);
  if (!voiceGate) throw new Error("Voice availability or registration identity changed");
  requireText(voice, /[A-Za-z_$][\w$]*\("realtimeVoice"\)\.hotkey/gu, "Voice preferred keymap");
  requireText(voice, /syncCommandKeybinding:[A-Za-z_$][\w$]*=>\{/gu, "Voice preference synchronization");
  requireText(voice, new RegExp("syncCommandKeybinding:(" + IDENT + ")=>\\{null!=\\1&&\\1!==" + escapeRegExp(voiceGate[1]) + "&&" + IDENT + "\\(\\1\\)," + escapeRegExp(voiceGate[1]) + "=\\1;try\\{" + escapeRegExp(voiceSync.name) + "\\(\\)\\}", "gu"), "Voice preferred keymap consumption");
  const voiceAction = one(matches(voice, new RegExp("(" + IDENT + ")=\\(\\)=>\\{" + escapeRegExp(voice.parameters.toggle) + "\\(\\)\\.catch\\(", "gu")), "native voice toggle wrapper")[1];
  requireText(voice, new RegExp(escapeRegExp(voice.parameters.subscribe) + "\\((" + IDENT + ")=>\\{" + escapeRegExp(voiceGate[2]) + "=\\1," + IDENT + "\\(\\1\\)," + IDENT + "\\(\\)\\}\\)", "gu"), "voice reservation override");
  const voiceCall = registration(voiceSync, register, "realtimeVoice", escapeRegExp(voiceGate[1]), 'onPressed:\\(\\)=>\\{"locked"!==' + escapeRegExp(electron) + "\\.powerMonitor\\.getSystemIdleState\\(1\\)&&" + escapeRegExp(voiceAction) + "\\(\\)\\}");

  const windows = constructedController(factory, producer, metadata, "windowManager");
  const meetingHead = one(matches(windows, new RegExp("\\bmeetingsHotkeyController=\\(function\\((" + IDENT + ")\\)\\{", "gu")), "Meetings controller field");
  const meeting = bodyAt(windows, meetingHead, "Meetings controller");
  const meetingSync = one(matches(meeting, /sync:([A-Za-z_$][\w$]*)=>\{\1===([A-Za-z_$][\w$]*)\|\|\(([A-Za-z_$][\w$]*)\(\),null!=\1&&null==([A-Za-z_$][\w$]*)\(\1\)&&/gu, false), "Meetings validation and sync identity");
  const meetingKey = escapeRegExp(meetingSync[1]), meetingIdentity = escapeRegExp(meetingSync[2]);
  const meetingCall = registration(meeting, register, "meetings", meetingKey, "onPressed:\\(\\)=>\\{" + meetingIdentity + "===" + meetingKey + '&&"locked"!==' + escapeRegExp(electron) + "\\.powerMonitor\\.getSystemIdleState\\(1\\)&&" + escapeRegExp(meetingHead[1]) + "\\(\\)\\}", "", false);
  requireText(meeting, new RegExp('warning\\("Unable to register Meetings shortcut",\\{safe:\\{\\},sensitive:\\{hotkey:' + meetingKey + "\\}\\}\\):" + meetingIdentity + "=" + meetingKey, "gu"), "Meetings committed registration identity");
  const meetingTail = windows.source.slice(meeting.end + 1, meeting.end + 650);
  if (!/^\)\(\(\)=>\{let ([A-Za-z_$][\w$]*)=this\.getPrimaryWindow\(\);null==\1\|\|this\.isAppQuitting\|\|this\.appShellShortcutStates\.get\(this\.getActiveWebContents\(\1\)\.id\)\?\.canTakeMeetingNotes!==!0\|\|this\.sendMessageToWindow\(\1,\{type:"run-command",id:"meetings\.takeNotes"\}\)\}\)/u.test(meetingTail)) throw new Error("Meetings window, access or quitting gate changed");
  requireText(method(windows, "syncMeetingsHotkey"), /t=!this\.isAppQuitting&&null!=e&&this\.appShellShortcutStates\.get\(this\.getActiveWebContents\(e\)\.id\)\?\.canTakeMeetingNotes===!0;this\.meetingsHotkeyController\.sync\(t\?[A-Za-z_$][\w$]*\("meetings\.takeNotes",this\.appShellCommandKeymapState\)\.hotkey:null\)/gu, "Meetings keymap and access synchronization");
  return [popout, petCall, appshotCall, voiceCall, meetingCall];
}
function decodeUnicode(source) {
  return source.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (token, braced, fixed) => {
    const point = parseInt(braced || fixed, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : token;
  });
}
function hasOwnArtifact(source) {
  if (typeof source !== "string") return false;
  const decoded = decodeUnicode(source);
  return decoded.includes(PATCH_MARKER) || decoded.includes(MARKER_NAME) ||
    new RegExp("(?:linuxCommandId|[\"']linuxCommandId[\"'])\\s*(?:\\])?\\s*:\\s*[\"'\\x60](?:" + ACTION_IDS.join("|") + ")[\"'\\x60]", "u").test(decoded);
}
function hasUnexpectedCommandTag(source) {
  const allowed = new Set([...ACTION_IDS, "globalDictationHold", "globalDictationSingleTap"]);
  const pattern = /(?:linuxCommandId|["']linuxCommandId["'])\s*(?:\])?\s*:\s*["'\x60]([^"'\x60]+)["'\x60]/gu;
  return [...decodeUnicode(source).matchAll(pattern)].some(match => !allowed.has(match[1]));
}
function edit(source, edits) {
  let result = source, previous = source.length;
  for (const change of edits.sort((left, right) => right.start - left.start)) {
    if (change.end > previous) throw new Error("Overlapping Wayland source edits");
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
    previous = change.start;
  }
  return result;
}
function markerPoint(source, metadata) {
  const start = metadata.owner.factoryBody.start;
  const directive = /^"use strict";/u.exec(source.slice(start, start + 13));
  return start + (directive?.[0].length ?? 0);
}
function applyCurrent(source, metadata, actions) {
  const changes = actions.map(action => ({ start: action.start, end: action.start, text: "linuxCommandId:" + JSON.stringify(action.id) + "," }));
  const marker = markerPoint(source, metadata);
  changes.push({ start: marker, end: marker, text: MARKER_SOURCE });
  return installPortalBackend(edit(source, changes));
}
function inspect(source, metadata = inspectGlobalShortcutsPortal(source)) {
  const result = { state: "unrelated", reason: metadata.reason, metadata };
  if (!metadata.owner) return { ...result, state: metadata.state === "drifted" || hasOwnArtifact(source) ? "drifted" : "unrelated" };
  try {
    if (hasUnexpectedCommandTag(source)) throw new Error("Unexpected action tag outside the five Wayland actions");
    const actions = actionPlan(source, metadata);
    if (!hasOwnArtifact(source)) return { ...result, state: "current", reason: null, actions };
    if (metadata.state !== "shared" || actions.some(action => !action.tagged)) throw new Error("Wayland feature marker or five-action adaptation is incomplete");
    const markerStart = markerPoint(source, metadata);
    if (source.slice(markerStart, markerStart + MARKER_SOURCE.length) !== MARKER_SOURCE) throw new Error("Wayland marker is outside its canonical declaration seam");
    const changes = actions.map(action => ({ start: action.start, end: action.start + ("linuxCommandId:" + JSON.stringify(action.id) + ",").length, text: "" }));
    changes.push({ start: markerStart, end: markerStart + MARKER_SOURCE.length, text: "" });
    const native = edit(source, changes);
    if (hasOwnArtifact(native)) throw new Error("Wayland artifacts exist outside the five owned action sites");
    const nativeMetadata = inspectGlobalShortcutsPortal(native), nativeActions = actionPlan(native, nativeMetadata);
    if (applyCurrent(native, nativeMetadata, nativeActions) !== source) throw new Error("Wayland canonical reconstruction changed the supplied source");
    return { ...result, state: "patched", reason: null, actions };
  } catch (error) { return { ...result, state: "drifted", reason: error.message }; }
}
function applyWaylandGlobalShortcutsPatch(source) {
  const current = inspect(source);
  if (current.state === "patched") return source;
  if (current.state !== "current") { warn(current.reason || "Live Wayland shortcut owners are unavailable"); return source; }
  try {
    const patched = applyCurrent(source, current.metadata, current.actions), complete = inspect(patched);
    if (complete.state !== "patched") { warn(complete.reason || "Wayland adaptation poststate is incomplete"); return source; }
    return patched;
  } catch (error) { warn(error.message); return source; }
}
function applyToExtractedApp(extractedDir) {
  const reject = reason => { warn(reason); return { matched: 0, changed: 0, changedAssets: [], reason }; };
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) return reject("Missing main-process inventory for Wayland shortcuts");
  if (inventory.chunks.length !== 19 || !inventory.chunks.includes("early-bootstrap.js")) return reject("Incomplete current nineteen-file main-process inventory");
  const records = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8"), metadata = inspectGlobalShortcutsPortal(source);
    return { assetName, source, metadata };
  });
  const owners = records.filter(record => record.metadata.owner);
  if (owners.length !== 1) return reject("Missing or ambiguous Wayland owner cohort");
  const owner = owners[0], identity = owner.metadata.owner.id;
  const cohort = records.filter(record => record.metadata.factoryIds.includes(identity) || hasOwnArtifact(record.source) || hasUnexpectedCommandTag(record.source) || record.metadata.state === "drifted");
  if (cohort.length !== 1 || cohort[0] !== owner) return reject("Duplicate, damaged or partial Wayland owner cohort");
  const current = inspect(owner.source, owner.metadata);
  const unchanged = records.map(record => ({ assetName: record.assetName, source: record.source, patchedSource: record.source }));
  const recheckInventory = () => {
    const latest = findMainProcessChunks(extractedDir);
    if (latest?.chunks.join("\n") !== inventory.chunks.join("\n")) throw new Error("Main-process inventory changed before Wayland patch commit");
  };
  if (current.state === "patched") {
    recheckInventory();
    return { matched: 1, ...commitAssetEdits(inventory.buildDir, unchanged) };
  }
  if (current.state !== "current") return reject(current.reason || "Incomplete Wayland action authority");
  const patchedSource = applyCurrent(owner.source, owner.metadata, current.actions), complete = inspect(patchedSource);
  if (complete.state !== "patched") return reject(complete.reason || "Wayland adaptation poststate is incomplete");
  const edits = records.map(record => ({ assetName: record.assetName, source: record.source, patchedSource: record === owner ? patchedSource : record.source }));
  recheckInventory();
  return { matched: 1, ...commitAssetEdits(inventory.buildDir, edits) };
}

module.exports = {
  applyWaylandGlobalShortcutsPatch,
  descriptors: [{ id: "wayland-global-shortcuts-actions", phase: "extracted-app:pre-webview", order: 146, apply: applyToExtractedApp }],
};
