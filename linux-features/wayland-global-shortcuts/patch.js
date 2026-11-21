"use strict";
const { IDENT, tagCommand, installPortalBackend } = require("../../scripts/patches/lib/global-shortcuts-portal.js");
const PATCH_MARKER = "codex-linux-wayland-global-shortcuts-v1";
function normalizeCurrentPortalLifecycle(source) {
  const header = new RegExp(
    `function\\(\\{(?<before>[^{}]{1,500}?)globalDictationLifecycleManager:(?<dictation>${IDENT}),` +
      `(?<after>[^{}]{1,500}?)flushAndDisposeContext:${IDENT},(?<tail>[^{}]{1,500}?)disposables:${IDENT}`,
    "u",
  ).exec(source);
  if (header != null && !header.groups.before.includes("hotkeyWindowLifecycleManager:")) {
    const call = "globalDictationLifecycleManager:";
    const callIndex = source.indexOf(call, header.index + header[0].length);
    const disposal = `${header.groups.dictation}.dispose(),Promise.allSettled([`;
    if (callIndex >= 0 && source.indexOf(call, callIndex + call.length) < 0 && source.split(disposal).length === 3) {
      source = source.slice(0, callIndex) + `hotkeyWindowLifecycleManager:{dispose(){}},${source.slice(callIndex)}`;
      source = source.replace(
        `globalDictationLifecycleManager:${header.groups.dictation},`,
        `hotkeyWindowLifecycleManager:codexLinuxNoopHotkeyLifecycle,globalDictationLifecycleManager:${header.groups.dictation},`,
      ).replaceAll(disposal, `codexLinuxNoopHotkeyLifecycle.dispose(),${disposal}`);
    }
  }
  const capture = new RegExp(
    `beginCapture\\(\\)\\{if\\(this\\.origin\\.isDestroyed\\(\\)\\)return null;let (${IDENT})=this\\.getFocusedOwnerWindow\\(\\);` +
      `return null==\\1\\?null:new (${IDENT})\\(this\\.origin,\\1\\)\\}` +
      `(?=getFocusedOwnerWindow\\(\\)\\{let ${IDENT}=(${IDENT})\\.BrowserWindow\\.getFocusedWindow\\(\\);)`,
    "u",
  ).exec(source);
  if (capture != null) {
    const replacement = `beginCapture(){if(this.origin.isDestroyed())return null;let ${capture[1]}=${capture[3]}.BrowserWindow.fromWebContents(this.origin);` +
      `return null!=${capture[1]}&&${capture[1]}.isFocused()?new ${capture[2]}(this.origin,${capture[1]}):null}`;
    source = source.slice(0, capture.index) + replacement + source.slice(capture.index + capture[0].length);
  }
  return source;
}
function applyWaylandGlobalShortcutsPatch(source) {
  if (source.includes(PATCH_MARKER)) return source;
  try {
    let patched = normalizeCurrentPortalLifecycle(source);
    for (const [id, key, callback] of [
      ["hotkeyWindow", IDENT, `(?:onPressed:\\(\\)=>\\{this\\.handleHotkeyWindowHotkeyPressed\\(\\)\\}|` +
        `onPressed:\\(\\)=>\\{this\\.toggle\\(\\)\\.catch\\([\\s\\S]{0,180}?"Failed to open Spotlight")`],
      ["openAvatarOverlay", IDENT, `onPressed:\\(\\)=>\\{${IDENT}\\(\\)\\?\\(null==${IDENT}\\|\\|"locked"!==${IDENT}\\.powerMonitor\\.getSystemIdleState\\(1\\)\\)&&\\(${IDENT}\\?\\?${IDENT}\\)\\(\\)\\.catch\\([\\s\\S]{0,200}?"Failed to open Quick Chat from global hotkey"`],
      ["appshots", "this\\.configuredHotkey", "onPressed:\\(\\)=>this\\.#[A-Za-z_$][\\w$]*\\(\\)"],
      ["realtimeVoice", IDENT, `onPressed:\\(\\)=>\\{"locked"!==${IDENT}\\.powerMonitor\\.getSystemIdleState\\(1\\)&&${IDENT}\\(\\)\\}`],
      ["meetings", IDENT, `onPressed:\\(\\)=>\\{${IDENT}===${IDENT}&&"locked"!==${IDENT}\\.powerMonitor\\.getSystemIdleState\\(1\\)&&${IDENT}\\(\\)\\}`],
    ]) {
      patched = tagCommand(patched, id, key, callback);
    }
    return installPortalBackend(`var codexLinuxWaylandGlobalShortcutsPatch=${JSON.stringify(PATCH_MARKER)};${patched}`);
  } catch (error) {
    console.warn(`WARN: ${error.message} - skipping Wayland global shortcuts patch`);
    return source;
  }
}
module.exports = {
  applyWaylandGlobalShortcutsPatch,
  descriptors: [{
    id: "wayland-global-shortcuts-actions",
    phase: "main-bundle",
    order: 146,
    apply: applyWaylandGlobalShortcutsPatch,
  }],
};
