"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const RUNTIME_VERSION = "omarchy-theme-v2";
const STYLE_LINK_ID = "codex-linux-omarchy-theme-link";
const THEME_CSS_ENV = "CODEX_LINUX_OMARCHY_STYLESHEET_URI";

function omarchyThemeRuntimeSource() {
  return [
    ";(()=>{",
    `const VERSION=${JSON.stringify(RUNTIME_VERSION)};`,
    "if(globalThis.codexLinuxOmarchyThemeVersion===VERSION)return;",
    "try{globalThis.codexLinuxOmarchyThemeCleanup?.()}catch{}",
    `const STYLE_LINK_ID=${JSON.stringify(STYLE_LINK_ID)};`,
    "let interval=null,installed=false,active=true,generation=0;",
    "async function refresh(){if(!active||typeof document===`undefined`)return;const request=++generation;try{const css=await globalThis.codexLinuxOmarchyTheme?.readStylesheet?.();if(!active||request!==generation||typeof css!==`string`)return;const target=document.head||document.documentElement;if(!target)return;let style=document.getElementById(STYLE_LINK_ID);if(style&&style.tagName!==`STYLE`){style.remove();style=null}if(!style){style=document.createElement(`style`);style.id=STYLE_LINK_ID;style.type=`text/css`;target.appendChild(style)}style.textContent=css}catch{}}",
    "function onVisibilityChange(){document.hidden||refresh()}",
    "function install(){if(installed||!active)return;installed=true;refresh();interval=setInterval(refresh,5000);window.addEventListener(`focus`,refresh);document.addEventListener(`visibilitychange`,onVisibilityChange)}",
    "function cleanup(){active=false;generation++;document.removeEventListener(`DOMContentLoaded`,install);document.removeEventListener(`visibilitychange`,onVisibilityChange);window.removeEventListener(`focus`,refresh);interval!=null&&clearInterval(interval);interval=null;installed=false;if(globalThis.codexLinuxOmarchyThemeVersion===VERSION)delete globalThis.codexLinuxOmarchyThemeVersion}",
    "globalThis.codexLinuxOmarchyThemeCleanup=cleanup;globalThis.codexLinuxOmarchyThemeVersion=VERSION;",
    "document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,install,{once:true}):install();",
    "})();",
  ].join("");
}

// The official webview is an rspack build. index.html loads the runtime entry
// chunk that exports __webpack_require__ and boots the app; the detached-window
// entry has the same runtime shape but boots initializeDetachedWindow instead.
const INDEX_ENTRY_NEEDLES = ["as __webpack_require__}", "codex-host-chunked-message-v1"];
const DETACHED_WINDOW_ENTRY_MARKER = "initializeDetachedWindow";

function isWebviewIndexEntry(source, assetName = "") {
  return typeof source === "string" &&
    !assetName.includes("/") &&
    INDEX_ENTRY_NEEDLES.every((needle) => source.split(needle).length === 2) &&
    !source.includes(DETACHED_WINDOW_ENTRY_MARKER);
}

function hasOmarchyRuntimeMarker(source) {
  return /\bcodexLinuxOmarchyTheme(?:Version|Cleanup)?\b/u.test(source) ||
    source.includes(RUNTIME_VERSION) || source.includes(STYLE_LINK_ID) || source.includes(THEME_CSS_ENV);
}

function omarchyThemeState(source) {
  if (!isWebviewIndexEntry(source)) return "invalid";
  const runtime = omarchyThemeRuntimeSource();
  const offset = source.indexOf(runtime);
  if (offset < 0) return hasOmarchyRuntimeMarker(source) ? "invalid" : "current";
  if (source.indexOf(runtime, offset + runtime.length) >= 0) return "invalid";
  const prefix = source.slice(0, offset);
  // The canonical IIFE must execute at entry scope, not be copied into a
  // function, block, template, string or comment that merely contains it.
  if (findMatchingBrace("{" + prefix + "}", 0) !== prefix.length + 1) return "invalid";
  const withoutRuntime = prefix + source.slice(offset + runtime.length);
  return hasOmarchyRuntimeMarker(withoutRuntime) ? "invalid" : "patched";
}

function applyOmarchyThemeLoader(source) {
  const state = omarchyThemeState(source);
  if (state === "patched") return source;
  if (state !== "current") {
    console.warn("WARN: Could not prove one complete webview index entry Omarchy runtime - leaving bundle unchanged");
    return source;
  }
  const patched = `${source}\n${omarchyThemeRuntimeSource()}`;
  if (omarchyThemeState(patched) === "patched") return patched;
  console.warn("WARN: Omarchy theme runtime poststate verification failed - leaving bundle unchanged");
  return source;
}

module.exports = {
  RUNTIME_VERSION,
  STYLE_LINK_ID,
  THEME_CSS_ENV,
  descriptors: [
    {
      id: "omarchy-theme-css-loader",
      phase: "extracted-app:pre-webview",
      order: 20_780,
      ciPolicy: "optional",
      assetNeedles: INDEX_ENTRY_NEEDLES,
      assetMatch: isWebviewIndexEntry,
      missingDescription: "webview index bundle",
      skipDescription: "Omarchy theme CSS loader",
      apply: (root) => require("./transport.js").applyOmarchyThemeToApp(root),
    },
  ],
  INDEX_ENTRY_NEEDLES,
  applyOmarchyThemeLoader,
  omarchyThemeState,
  hasOmarchyRuntimeMarker,
  isWebviewIndexEntry,
  omarchyThemeRuntimeSource,
};
