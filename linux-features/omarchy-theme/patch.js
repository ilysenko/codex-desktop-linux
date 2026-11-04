"use strict";

const RUNTIME_VERSION = "omarchy-theme-v1";
const STYLE_LINK_ID = "codex-linux-omarchy-theme-link";
const THEME_CSS_ENV = "CODEX_LINUX_OMARCHY_STYLESHEET_URI";

function omarchyThemeRuntimeSource() {
  return [
    ";(()=>{",
    `const VERSION=${JSON.stringify(RUNTIME_VERSION)};`,
    "if(globalThis.codexLinuxOmarchyThemeVersion===VERSION)return;",
    "try{globalThis.codexLinuxOmarchyThemeCleanup?.()}catch{}",
    "globalThis.codexLinuxOmarchyThemeVersion=VERSION;",
    `const STYLE_LINK_ID=${JSON.stringify(STYLE_LINK_ID)};`,
    `const THEME_CSS_ENV=${JSON.stringify(THEME_CSS_ENV)};`,
    "let interval=null,installed=false;",
    "function refresh(){if(typeof document===`undefined`)return;const uri=globalThis.process?.env?.[THEME_CSS_ENV];if(!uri)return;const target=document.head||document.documentElement;if(!target)return;let link=document.getElementById(STYLE_LINK_ID);if(!link){link=document.createElement(`link`);link.id=STYLE_LINK_ID;link.rel=`stylesheet`;link.type=`text/css`;target.appendChild(link)}link.href=uri+`?t=`+Date.now()}",
    "function onVisibilityChange(){document.hidden||refresh()}",
    "function install(){if(installed)return;installed=true;refresh();interval=setInterval(refresh,5000);window.addEventListener(`focus`,refresh);document.addEventListener(`visibilitychange`,onVisibilityChange)}",
    "function cleanup(){document.removeEventListener(`DOMContentLoaded`,install);document.removeEventListener(`visibilitychange`,onVisibilityChange);window.removeEventListener(`focus`,refresh);interval!=null&&clearInterval(interval);interval=null;installed=false}",
    "globalThis.codexLinuxOmarchyThemeCleanup=cleanup;",
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
    INDEX_ENTRY_NEEDLES.every((needle) => source.includes(needle)) &&
    !source.includes(DETACHED_WINDOW_ENTRY_MARKER);
}

function applyOmarchyThemeLoader(source) {
  if (typeof source !== "string") {
    return source;
  }
  if (source.includes("codexLinuxOmarchyThemeVersion=")) {
    return source;
  }
  if (!isWebviewIndexEntry(source)) {
    console.warn("WARN: Could not confirm the webview index entry chunk - skipping Omarchy theme CSS loader");
    return source;
  }
  return `${source}\n${omarchyThemeRuntimeSource()}`;
}

module.exports = {
  RUNTIME_VERSION,
  STYLE_LINK_ID,
  THEME_CSS_ENV,
  descriptors: [
    {
      id: "omarchy-theme-css-loader",
      phase: "webview-asset",
      order: 20_780,
      ciPolicy: "optional",
      assetNeedles: INDEX_ENTRY_NEEDLES,
      assetMatch: isWebviewIndexEntry,
      missingDescription: "webview index bundle",
      skipDescription: "Omarchy theme CSS loader",
      apply: applyOmarchyThemeLoader,
    },
  ],
  INDEX_ENTRY_NEEDLES,
  applyOmarchyThemeLoader,
  isWebviewIndexEntry,
  omarchyThemeRuntimeSource,
};
