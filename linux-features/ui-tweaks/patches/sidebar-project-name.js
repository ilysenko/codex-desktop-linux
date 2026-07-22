"use strict";

const DEFAULT_PROJECT_NAME_STYLE = "font-weight: 700 !important;";
const PROJECTS_SIDEBAR_ASSET_PATTERN =
  /^app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~lpx9dmpy-[^.]+\.js$/;
const PROJECT_NAME_SELECTOR = ".group\\/folder-row .text-fade-truncate.pr-1";
const STYLE_ID = "codex-linux-ui-tweaks-sidebar-project-name-style";
const RUNTIME_MARKER = "codexLinuxUiTweaksSidebarProjectNameStyleRuntime";
const UNSAFE_PROJECT_NAME_STYLE_PATTERN = /[{}@<>]|\r|\n|\/\*|\*\/|\burl\s*\(/i;

const SIDEBAR_PROJECT_NAME_MARKERS = [
  "group/folder-row",
  "className:`text-fade-truncate pr-1`",
];

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks sidebar project name patch`);
}

function sidebarProjectNameCss(style = DEFAULT_PROJECT_NAME_STYLE) {
  return `${PROJECT_NAME_SELECTOR}{${style}}`;
}

function sidebarProjectNameStyleRuntimeSource(style = DEFAULT_PROJECT_NAME_STYLE) {
  const css = sidebarProjectNameCss(style);
  return [
    `;(()=>{const ${RUNTIME_MARKER}=true;`,
    `const STYLE_ID=${JSON.stringify(STYLE_ID)};`,
    `const CSS=${JSON.stringify(css)};`,
    `function install(){if(typeof document==="undefined")return;const target=document.head||document.documentElement;if(!target)return;let style=document.getElementById(STYLE_ID);if(style){style.textContent!==CSS&&(style.textContent=CSS);return}style=document.createElement("style");style.id=STYLE_ID;style.textContent=CSS;target.appendChild(style)}`,
    `document.readyState==="loading"&&document.addEventListener("DOMContentLoaded",install,{once:true});install();})();`,
  ].join("");
}

function isSafeProjectNameStyle(style) {
  return !UNSAFE_PROJECT_NAME_STYLE_PATTERN.test(style);
}

function sidebarProjectNameConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.sidebar?.projectName;
  const settings = context?.feature?.settings?.tweaks?.sidebar?.projectName;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function normalizedProjectNameStyle(context) {
  const config = sidebarProjectNameConfig(context);
  if (config.enabled === false) {
    return { enabled: false, style: DEFAULT_PROJECT_NAME_STYLE };
  }

  if (config.style == null) {
    return { enabled: true, style: DEFAULT_PROJECT_NAME_STYLE };
  }

  if (typeof config.style !== "string") {
    console.warn("WARN: ui-tweaks sidebar project name style must be a string - using default bold style");
    return { enabled: true, style: DEFAULT_PROJECT_NAME_STYLE };
  }

  const style = config.style.trim();
  if (style.length === 0) {
    console.warn("WARN: ui-tweaks sidebar project name style is empty - using default bold style");
    return { enabled: true, style: DEFAULT_PROJECT_NAME_STYLE };
  }

  if (!isSafeProjectNameStyle(style)) {
    console.warn(
      "WARN: ui-tweaks sidebar project name style must be a safe CSS declaration list - using default bold style",
    );
    return { enabled: true, style: DEFAULT_PROJECT_NAME_STYLE };
  }

  return { enabled: true, style };
}

function looksLikeSidebarProjectBundle(source) {
  return SIDEBAR_PROJECT_NAME_MARKERS.every((marker) => source.includes(marker));
}

function hasPartialSidebarProjectMarkers(source) {
  return SIDEBAR_PROJECT_NAME_MARKERS.some((marker) => source.includes(marker));
}

function applySidebarProjectNameStylePatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }

    const { enabled, style } = normalizedProjectNameStyle(context);
    if (!enabled || source.includes(RUNTIME_MARKER) || source.includes(STYLE_ID)) {
      return source;
    }

    if (!looksLikeSidebarProjectBundle(source)) {
      if (context.warnOnMissingMarkers === true || hasPartialSidebarProjectMarkers(source)) {
        warn("Could not find current sidebar project name markers");
      }
      return source;
    }

    return `${source}\n${sidebarProjectNameStyleRuntimeSource(style)}`;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

const descriptors = [
  {
    id: "sidebar-project-name-style",
    phase: "webview-asset",
    order: 20_790,
    ciPolicy: "optional",
    pattern: PROJECTS_SIDEBAR_ASSET_PATTERN,
    missingDescription: "projects sidebar bundle",
    skipDescription: "ui-tweaks sidebar project name style patch",
    apply: (source, context = {}) =>
      applySidebarProjectNameStylePatch(source, { ...context, warnOnMissingMarkers: true }),
  },
];

module.exports = {
  DEFAULT_PROJECT_NAME_STYLE,
  PROJECTS_SIDEBAR_ASSET_PATTERN,
  PROJECT_NAME_SELECTOR,
  RUNTIME_MARKER,
  STYLE_ID,
  applySidebarProjectNameStylePatch,
  descriptors,
  normalizedProjectNameStyle,
  sidebarProjectNameCss,
  sidebarProjectNameStyleRuntimeSource,
};
