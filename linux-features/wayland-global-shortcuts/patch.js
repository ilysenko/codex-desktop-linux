"use strict";
const { IDENT, tagCommand, installPortalBackend } = require("../../scripts/patches/lib/global-shortcuts-portal.js");
const PATCH_MARKER = "codex-linux-wayland-global-shortcuts-v1";
function applyWaylandGlobalShortcutsPatch(source) {
  if (source.includes(PATCH_MARKER)) return source;
  try {
    let patched = source;
    for (const [id, key, callback] of [
      ["hotkeyWindow", "e", "onPressed:\\(\\)=>\\{this\\.handleHotkeyWindowHotkeyPressed\\(\\)\\}"],
      ["openAvatarOverlay", IDENT, `onPressed:\\(\\)=>\\{${IDENT}\\(\\)\\?${IDENT}\\(\\)\\.catch\\([\\s\\S]{0,200}?"Failed to toggle pet from global hotkey"`],
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
