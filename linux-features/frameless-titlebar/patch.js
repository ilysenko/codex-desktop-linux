"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const CHROME_MAPPING_ASSET_PATTERN = /^app-shared-[A-Za-z0-9_-]+\.js$/;
const CURRENT_CHROME_MAPPING = "case`win32`:case`linux`:return`application-menu`";
const PATCHED_CHROME_MAPPING = "case`win32`:return`application-menu`;case`linux`:return`native`";

// The rspack main-process chunks use literal-first comparisons, double-quoted
// strings, and early returns inside the window-options switch.
const currentWindowOptionsPattern = new RegExp(
  `if\\("win32"===(${IDENT})\\|\\|"linux"===\\1\\)return\\{titleBarStyle:"hidden",titleBarOverlay:(${IDENT})\\((${IDENT})\\)\\};`,
  "g",
);
const patchedWindowOptionsPattern = new RegExp(
  `if\\("win32"===(${IDENT})\\)return\\{titleBarStyle:"hidden",titleBarOverlay:(${IDENT})\\((${IDENT})\\)\\};` +
    `if\\("linux"===\\1\\)return\\{titleBarStyle:"hidden"\\};`,
  "g",
);
const detachedWindowPrefix =
  `case"detached":if\\("darwin"===(${IDENT})\\)return` +
  `(\\{titleBarStyle:"hiddenInset",titleBarOverlay:!0,trafficLightPosition:${IDENT}\\([^()]*\\)\\});`;
const currentDetachedOptionsPattern = new RegExp(
  detachedWindowPrefix + `return\\{titleBarStyle:"hidden",titleBarOverlay:(${IDENT})\\((${IDENT})\\)\\}`,
  "g",
);
const patchedDetachedOptionsPattern = new RegExp(
  detachedWindowPrefix + `if\\("linux"===\\1\\)return\\{titleBarStyle:"hidden"\\};` +
    `return\\{titleBarStyle:"hidden",titleBarOverlay:(${IDENT})\\((${IDENT})\\)\\}`,
  "g",
);
const currentZoomOverlayPattern = new RegExp(
  `\\("win32"===process\\.platform\\|\\|"linux"===process\\.platform\\)&&\\(this\\.windowZooms\\.set\\((${IDENT})\\.id,(${IDENT})\\),\\1\\.setTitleBarOverlay\\((${IDENT})\\(\\2\\)\\)\\)`,
  "g",
);
const patchedZoomOverlayPattern = new RegExp(
  `"win32"===process\\.platform&&\\(this\\.windowZooms\\.set\\((${IDENT})\\.id,(${IDENT})\\),\\1\\.setTitleBarOverlay\\((${IDENT})\\(\\2\\)\\)\\)`,
  "g",
);
const currentOverlaySyncPattern = new RegExp(
  `installApplicationMenuTitleBarOverlaySync\\((${IDENT}),(${IDENT})\\)\\{if\\("win32"!==process\\.platform&&"linux"!==process\\.platform\\|\\|"primary"!==\\2&&"detached"!==\\2\\)return;`,
  "g",
);
const patchedOverlaySyncPattern = new RegExp(
  `installApplicationMenuTitleBarOverlaySync\\((${IDENT}),(${IDENT})\\)\\{if\\("win32"!==process\\.platform\\|\\|"primary"!==\\2&&"detached"!==\\2\\)return;`,
  "g",
);

const mainContracts = [
  [currentWindowOptionsPattern, patchedWindowOptionsPattern],
  [currentDetachedOptionsPattern, patchedDetachedOptionsPattern],
  [currentZoomOverlayPattern, patchedZoomOverlayPattern],
  [currentOverlaySyncPattern, patchedOverlaySyncPattern],
];

function matchCount(source, pattern) {
  if (typeof source !== "string") return 0;
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].length;
}

function countOccurrences(source, needle) {
  return typeof source === "string" ? source.split(needle).length - 1 : 0;
}

function classifyContracts(source, pairs) {
  if (typeof source !== "string") return "drifted";
  const currentCounts = pairs.map(([current]) => matchCount(source, current));
  const patchedCounts = pairs.map(([, patched]) => matchCount(source, patched));
  if (currentCounts.every((count) => count === 1) && patchedCounts.every((count) => count === 0)) {
    return "current";
  }
  if (currentCounts.every((count) => count === 0) && patchedCounts.every((count) => count === 1)) {
    return "patched";
  }
  return "drifted";
}

function framelessTitlebarMainContract(source) {
  return classifyContracts(source, mainContracts);
}

function framelessTitlebarWebviewContract(source) {
  const currentCount = countOccurrences(source, CURRENT_CHROME_MAPPING);
  const patchedCount = countOccurrences(source, PATCHED_CHROME_MAPPING);
  if (currentCount === 1 && patchedCount === 0) return "current";
  if (currentCount === 0 && patchedCount === 1) return "patched";
  return "drifted";
}

function warn(surface) {
  console.warn(
    `WARN: Could not find the complete current frameless-titlebar ${surface} contract - skipping frameless titlebar ${surface} patch`,
  );
}

function applyFramelessTitlebarMainPatch(source) {
  const contract = framelessTitlebarMainContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    warn("main-process");
    return source;
  }

  const patched = source
    .replace(
      currentWindowOptionsPattern,
      (_match, platform, overlayHelper, zoom) =>
        `if("win32"===${platform})return{titleBarStyle:"hidden",titleBarOverlay:${overlayHelper}(${zoom})};` +
        `if("linux"===${platform})return{titleBarStyle:"hidden"};`,
    )
    .replace(
      currentDetachedOptionsPattern,
      (_match, platform, darwinOptions, overlayHelper, zoom) =>
        `case"detached":if("darwin"===${platform})return${darwinOptions};` +
        `if("linux"===${platform})return{titleBarStyle:"hidden"};` +
        `return{titleBarStyle:"hidden",titleBarOverlay:${overlayHelper}(${zoom})}`,
    )
    .replace(
      currentZoomOverlayPattern,
      (_match, windowAlias, zoomAlias, overlayHelper) =>
        `"win32"===process.platform&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(${overlayHelper}(${zoomAlias})))`,
    )
    .replace(
      currentOverlaySyncPattern,
      (_match, windowAlias, windowTypeAlias) =>
        `installApplicationMenuTitleBarOverlaySync(${windowAlias},${windowTypeAlias}){if("win32"!==process.platform||"primary"!==${windowTypeAlias}&&"detached"!==${windowTypeAlias})return;`,
    );

  if (framelessTitlebarMainContract(patched) !== "patched") {
    warn("main-process");
    return source;
  }
  return patched;
}

function applyFramelessTitlebarWebviewPatch(source) {
  const contract = framelessTitlebarWebviewContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    warn("webview");
    return source;
  }

  const patched = source.replace(CURRENT_CHROME_MAPPING, PATCHED_CHROME_MAPPING);
  if (framelessTitlebarWebviewContract(patched) !== "patched") {
    warn("webview");
    return source;
  }
  return patched;
}

module.exports = {
  CHROME_MAPPING_ASSET_PATTERN,
  descriptors: [
    {
      id: "main-process",
      phase: "main-bundle",
      order: 20_720,
      ciPolicy: "optional",
      apply: applyFramelessTitlebarMainPatch,
    },
    {
      id: "webview-chrome-mapping",
      phase: "webview-asset",
      order: 20_730,
      ciPolicy: "optional",
      pattern: CHROME_MAPPING_ASSET_PATTERN,
      assetMatch: (source) => framelessTitlebarWebviewContract(source) !== "drifted",
      missingDescription: "official Linux chrome-mapping bundle",
      skipDescription: "frameless titlebar webview chrome patch",
      apply: applyFramelessTitlebarWebviewPatch,
    },
  ],
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarWebviewPatch,
  framelessTitlebarMainContract,
  framelessTitlebarWebviewContract,
};
