"use strict";

const { extractedAppPatch, webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  SIDEBAR_ASSET_NEEDLES,
  TAB_ASSET_NEEDLES,
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationStylesheetPatch,
  applyLinuxSidebarScrollPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxSidebarScrollPerformanceContract,
} = require("./implementation.js");

module.exports = [
  webviewAssetPatch({
    id: "sidebar-scroll",
    phase: "webview-asset",
    order: 20_100,
    ciPolicy: "optional",
    assetNeedles: SIDEBAR_ASSET_NEEDLES,
    assetMatch: matchesLinuxSidebarScrollPerformanceContract,
    missingDescription: "main sidebar scroll bundle",
    skipDescription: "sidebar scroll performance workaround",
    apply: applyLinuxSidebarScrollPerformancePatch,
  }),
  webviewAssetPatch({
    id: "app-shell-tab-layout",
    phase: "webview-asset",
    order: 20_110,
    ciPolicy: "optional",
    assetNeedles: TAB_ASSET_NEEDLES,
    assetMatch: matchesLinuxAppShellTabLayoutPerformanceContract,
    missingDescription: "app-shell tab layout bundle",
    skipDescription: "app-shell tab layout performance workaround",
    apply: applyLinuxAppShellTabLayoutPerformancePatch,
  }),
  // The rspack stylesheet lives in webview/assets/async/*.css, which the
  // script-only webview-asset index does not cover.
  extractedAppPatch({
    id: "markdown-animation",
    phase: "extracted-app:post-webview",
    order: 20_120,
    ciPolicy: "optional",
    apply: applyLinuxMarkdownAnimationStylesheetPatch,
  }),
];
