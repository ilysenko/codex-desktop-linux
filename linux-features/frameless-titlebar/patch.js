"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const APP_INITIAL_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const CURRENT_CHROME_MAPPING = "case`win32`:case`linux`:return`application-menu`";
const PATCHED_CHROME_MAPPING = "case`win32`:return`application-menu`;case`linux`:return`native`";

const currentWindowOptionsPattern = new RegExp(
  `(${IDENT})===\\\`win32\\\`\\|\\|\\1===\\\`linux\\\`\\?\\{titleBarStyle:\\\`hidden\\\`,titleBarOverlay:(${IDENT})\\((${IDENT})\\),(\\.\\.\\.(${IDENT})===\\\`quickChat\\\`\\?\\{resizable:!0\\}:\\{\\})\\}`,
  "g",
);
const patchedWindowOptionsPattern = new RegExp(
  `(${IDENT})===\\\`win32\\\`\\?\\{titleBarStyle:\\\`hidden\\\`,titleBarOverlay:(${IDENT})\\((${IDENT})\\),(\\.\\.\\.(${IDENT})===\\\`quickChat\\\`\\?\\{resizable:!0\\}:\\{\\})\\}:` +
    `\\1===\\\`linux\\\`\\?\\{titleBarStyle:\\\`hidden\\\`,\\4\\}`,
  "g",
);
const currentZoomOverlayPattern = new RegExp(
  `\\(process\\.platform===\\\`win32\\\`\\|\\|process\\.platform===\\\`linux\\\`\\)&&\\(this\\.windowZooms\\.set\\((${IDENT})\\.id,(${IDENT})\\),\\1\\.setTitleBarOverlay\\((${IDENT})\\(\\2\\)\\)\\)`,
  "g",
);
const patchedZoomOverlayPattern = new RegExp(
  `process\\.platform===\\\`win32\\\`&&\\(this\\.windowZooms\\.set\\((${IDENT})\\.id,(${IDENT})\\),\\1\\.setTitleBarOverlay\\((${IDENT})\\(\\2\\)\\)\\)`,
  "g",
);
const currentOverlaySyncPattern = new RegExp(
  `installApplicationMenuTitleBarOverlaySync\\((${IDENT}),(${IDENT})\\)\\{if\\(process\\.platform!==\\\`win32\\\`&&process\\.platform!==\\\`linux\\\`\\|\\|\\2!==\\\`primary\\\`&&\\2!==\\\`quickChat\\\`\\)return;`,
  "g",
);
const patchedOverlaySyncPattern = new RegExp(
  `installApplicationMenuTitleBarOverlaySync\\((${IDENT}),(${IDENT})\\)\\{if\\(process\\.platform!==\\\`win32\\\`\\|\\|\\2!==\\\`primary\\\`&&\\2!==\\\`quickChat\\\`\\)return;`,
  "g",
);

const mainContracts = [
  [currentWindowOptionsPattern, patchedWindowOptionsPattern],
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
      (_match, platform, overlayHelper, zoom, quickChatOptions) =>
        `${platform}===\`win32\`?{titleBarStyle:\`hidden\`,titleBarOverlay:${overlayHelper}(${zoom}),${quickChatOptions}}:` +
        `${platform}===\`linux\`?{titleBarStyle:\`hidden\`,${quickChatOptions}}`,
    )
    .replace(
      currentZoomOverlayPattern,
      (_match, windowAlias, zoomAlias, overlayHelper) =>
        `process.platform===\`win32\`&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(${overlayHelper}(${zoomAlias})))`,
    )
    .replace(
      currentOverlaySyncPattern,
      (_match, windowAlias, windowTypeAlias) =>
        `installApplicationMenuTitleBarOverlaySync(${windowAlias},${windowTypeAlias}){if(process.platform!==\`win32\`||${windowTypeAlias}!==\`primary\`&&${windowTypeAlias}!==\`quickChat\`)return;`,
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
  APP_INITIAL_ASSET_PATTERN,
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
      pattern: APP_INITIAL_ASSET_PATTERN,
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
