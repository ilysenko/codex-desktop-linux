"use strict";

const { escapeRegExp } = require("./minified-js.js");
const IDENT = "[A-Za-z_$][\\w$]*";

function linuxAppshotWaylandHelperSource() {
  return "function codexLinuxAppshotIsWayland(){return process.platform===`linux`&&((process.env.XDG_SESSION_TYPE||``).toLowerCase()===`wayland`||!!process.env.WAYLAND_DISPLAY)}";
}

function literalPattern(source) {
  return new RegExp(escapeRegExp(source), "g");
}

function appshotHotkeyPatterns(source) {
  // Correlate the bare-modifier eligibility helper with the normalizer used by
  // the current anonymous native-monitor registration, rather than a short name.
  const registrations = [...source.matchAll(new RegExp(
    `function\\((${IDENT}),(${IDENT}),(${IDENT})="press"\\)\\{[^{}]{0,300}?` +
      `if\\("darwin"!==process\\.platform(?:&&"linux"!==process\\.platform)?\\)return null;` +
      `let ${IDENT}=(${IDENT})\\(\\1\\)(?:\\?\\?${IDENT}\\(\\1\\))?;`, "g"))];
  if (registrations.length !== 1 || !registrations[0][0].includes("??")) return null;
  const registration = registrations[0];
  const currentRegistration = registration[0].replace(
    'if("darwin"!==process.platform&&"linux"!==process.platform)', 'if("darwin"!==process.platform)');
  const patchedRegistration = currentRegistration.replace(
    'if("darwin"!==process.platform)', 'if("darwin"!==process.platform&&"linux"!==process.platform)');
  const normalizer = escapeRegExp(registration[4]);
  return [
    {
      role: "eligibility",
      current: new RegExp(`function (${IDENT})\\((${IDENT}),(${IDENT})=process\\.platform\\)\\{return"darwin"===\\3&&null!=(${normalizer})\\(\\2\\)\\}`, "g"),
      patched: new RegExp(`function (${IDENT})\\((${IDENT}),(${IDENT})=process\\.platform\\)\\{return\\("darwin"===\\3\\|\\|"linux"===\\3&&!codexLinuxAppshotIsWayland\\(\\)\\)&&null!=(${normalizer})\\(\\2\\)\\}`, "g"),
      replace: (_match, fn, hotkey, platform, normalize) =>
        `function ${fn}(${hotkey},${platform}=process.platform){return("darwin"===${platform}||"linux"===${platform}&&!codexLinuxAppshotIsWayland())&&null!=${normalize}(${hotkey})}`,
    },
    { role: "monitor", current: literalPattern(currentRegistration), patched: literalPattern(patchedRegistration), replace: patchedRegistration },
    {
      role: "modifiers",
      current: /new Set\(\[\.\.\.([A-Za-z_$][\w$]*),"shift"\]\)/g,
      patched: /new Set\(\[\.\.\.([A-Za-z_$][\w$]*),"shift","meta","win"\]\)/g,
      replace: (_match, base) => `new Set([...${base},"shift","meta","win"])`,
    },
    {
      role: "defaultShortcut",
      current: new RegExp(`void 0===(${IDENT})\\?this\\.configuredHotkey="win32"===process\\.platform\\?"DoubleAlt":"DoubleCommand":this\\.configuredHotkey=\\1`, "g"),
      patched: new RegExp(`void 0===(${IDENT})\\?this\\.configuredHotkey="win32"===process\\.platform\\?"DoubleAlt":"linux"===process\\.platform\\?null:"DoubleCommand":this\\.configuredHotkey=\\1`, "g"),
      replace: (_match, stored) => `void 0===${stored}?this.configuredHotkey="win32"===process.platform?"DoubleAlt":"linux"===process.platform?null:"DoubleCommand":this.configuredHotkey=${stored}`,
    },
    {
      role: "availability",
      current: /supported:this\.enabled&&\("darwin"===process\.platform\|\|"win32"===process\.platform&&null!=this\.windowsCaptureNativeBridge&&!this\.windowsCaptureNativeBridgeFailed\),configuredHotkey:this\.configuredHotkey,isActive:null!=this\.registration/g,
      patched: /supported:this\.enabled&&\("linux"===process\.platform\|\|"darwin"===process\.platform\|\|"win32"===process\.platform&&null!=this\.windowsCaptureNativeBridge&&!this\.windowsCaptureNativeBridgeFailed\),configuredHotkey:this\.configuredHotkey,isActive:null!=this\.registration,linuxWayland:codexLinuxAppshotIsWayland\(\)/g,
      replace: 'supported:this.enabled&&("linux"===process.platform||"darwin"===process.platform||"win32"===process.platform&&null!=this.windowsCaptureNativeBridge&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:null!=this.registration,linuxWayland:codexLinuxAppshotIsWayland()',
    },
  ];
}

function appshotHotkeyState(source) {
  const patterns = appshotHotkeyPatterns(source);
  if (patterns == null) return { kind: "invalid" };
  const currentCounts = patterns.map(({ current }) => [...source.matchAll(current)].length);
  const patchedCounts = patterns.map(({ patched }) => [...source.matchAll(patched)].length);
  const helper = linuxAppshotWaylandHelperSource();
  const helperCount = source.split(helper).length - 1;
  if (currentCounts.every((count) => count === 1) && patchedCounts.every((count) => count === 0) &&
      !source.includes("codexLinuxAppshotIsWayland")) return { kind: "current", patterns };
  if (currentCounts.every((count) => count === 0) && patchedCounts.every((count) => count === 1) &&
      helperCount === 1 && source.split("codexLinuxAppshotIsWayland").length === 4) return { kind: "patched", patterns };
  return { kind: "invalid" };
}

function matchesLinuxAppshotHotkeyContract(source) {
  return appshotHotkeyState(source).kind !== "invalid";
}

module.exports = { appshotHotkeyState, linuxAppshotWaylandHelperSource, matchesLinuxAppshotHotkeyContract };
