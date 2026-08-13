"use strict";

const APP_INITIAL_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const STYLE_ID = "codex-linux-hover-scrollbars-style";
const RUNTIME_MARKER = "codexLinuxHoverScrollbarsRuntime";
const SIDEBAR_MARKER = "data-app-action-sidebar-scroll";

const HOVER_SCROLLBAR_CSS = [
  ".overflow-auto,.overflow-scroll,.overflow-x-auto,.overflow-y-auto,.overflow-x-scroll,.overflow-y-scroll{",
  "transition:scrollbar-color var(--transition-duration-basic,150ms) ease;",
  "scrollbar-color:transparent transparent!important",
  "}",
  ".overflow-auto:hover,.overflow-scroll:hover,.overflow-x-auto:hover,.overflow-y-auto:hover,.overflow-x-scroll:hover,.overflow-y-scroll:hover{",
  "scrollbar-color:var(--color-token-scrollbar-slider-hover-background) transparent!important",
  "}",
  ".overflow-auto::-webkit-scrollbar-thumb,.overflow-scroll::-webkit-scrollbar-thumb,.overflow-x-auto::-webkit-scrollbar-thumb,.overflow-y-auto::-webkit-scrollbar-thumb,.overflow-x-scroll::-webkit-scrollbar-thumb,.overflow-y-scroll::-webkit-scrollbar-thumb{",
  "background-color:#0000",
  "}",
  ".overflow-auto:hover::-webkit-scrollbar-thumb,.overflow-scroll:hover::-webkit-scrollbar-thumb,.overflow-x-auto:hover::-webkit-scrollbar-thumb,.overflow-y-auto:hover::-webkit-scrollbar-thumb,.overflow-x-scroll:hover::-webkit-scrollbar-thumb,.overflow-y-scroll:hover::-webkit-scrollbar-thumb{",
  "background-color:var(--color-token-scrollbar-slider-hover-background)",
  "}",
  ".overflow-auto::-webkit-scrollbar-track,.overflow-scroll::-webkit-scrollbar-track,.overflow-x-auto::-webkit-scrollbar-track,.overflow-y-auto::-webkit-scrollbar-track,.overflow-x-scroll::-webkit-scrollbar-track,.overflow-y-scroll::-webkit-scrollbar-track{",
  "background-color:#0000",
  "}",
  '[class*="scrollbar-gutter:stable"],.scrollbar-stable{scrollbar-gutter:auto}',
].join("");

function warn() {
  console.warn(
    "WARN: Could not find the complete current hover-scrollbars app-initial contract - skipping hover-scrollbars patch",
  );
}

function looksLikeAppInitialBundle(source) {
  return typeof source === "string" &&
    source.includes(SIDEBAR_MARKER) &&
    source.includes("overflow-y-auto") &&
    source.includes("thread-scroll-container") === false;
}

function hoverScrollbarsContract(source) {
  if (typeof source !== "string") return "drifted";
  const hasMarker = source.includes(RUNTIME_MARKER) && source.includes(STYLE_ID);
  if (hasMarker && looksLikeAppInitialBundle(source)) return "patched";
  if (!hasMarker && looksLikeAppInitialBundle(source)) return "current";
  return "drifted";
}

function hoverScrollbarsRuntimeSource() {
  return [
    `;(()=>{const ${RUNTIME_MARKER}=true;`,
    `const STYLE_ID=${JSON.stringify(STYLE_ID)};`,
    `const CSS=${JSON.stringify(HOVER_SCROLLBAR_CSS)};`,
    `function install(){if(typeof document==="undefined")return;const target=document.head||document.documentElement;if(!target)return;let style=document.getElementById(STYLE_ID);if(style){style.textContent!==CSS&&(style.textContent=CSS);return}style=document.createElement("style");style.id=STYLE_ID;style.textContent=CSS;target.appendChild(style)}`,
    `document.readyState==="loading"&&document.addEventListener("DOMContentLoaded",install,{once:true});install();})();`,
  ].join("");
}

function applyHoverScrollbarsPatch(source) {
  const contract = hoverScrollbarsContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    warn();
    return source;
  }

  const patched = `${source}\n${hoverScrollbarsRuntimeSource()}`;
  if (hoverScrollbarsContract(patched) !== "patched") {
    warn();
    return source;
  }
  return patched;
}

module.exports = {
  APP_INITIAL_ASSET_PATTERN,
  HOVER_SCROLLBAR_CSS,
  RUNTIME_MARKER,
  SIDEBAR_MARKER,
  STYLE_ID,
  applyHoverScrollbarsPatch,
  descriptors: [
    {
      id: "app-initial-style",
      phase: "webview-asset",
      order: 21_200,
      ciPolicy: "optional",
      pattern: APP_INITIAL_ASSET_PATTERN,
      assetMatch: (source) => hoverScrollbarsContract(source) !== "drifted",
      missingDescription: "official Linux app-initial bundle",
      skipDescription: "hover-scrollbars patch",
      apply: applyHoverScrollbarsPatch,
    },
  ],
  hoverScrollbarsContract,
  hoverScrollbarsRuntimeSource,
};
