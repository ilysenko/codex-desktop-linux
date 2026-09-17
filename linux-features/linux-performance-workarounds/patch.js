"use strict";

const { webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  applyLinuxAppShellTabLayoutPerformancePatch,
  applyLinuxMarkdownAnimationPerformancePatch,
  applyLinuxSidebarScrollPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
  matchesLinuxMarkdownAnimationPerformanceContract,
  matchesLinuxSidebarScrollPerformanceContract,
} = require("./implementation.js");

module.exports = [
  webviewAssetPatch({
    id: "sidebar-scroll",
    phase: "webview-asset",
    order: 20_100,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
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
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesLinuxAppShellTabLayoutPerformanceContract,
    missingDescription: "app-shell tab layout bundle",
    skipDescription: "app-shell tab layout performance workaround",
    apply: applyLinuxAppShellTabLayoutPerformancePatch,
  }),
  webviewAssetPatch({
    id: "markdown-animation",
    phase: "webview-asset",
    order: 20_120,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.css$/,
    assetMatch: matchesLinuxMarkdownAnimationPerformanceContract,
    missingDescription: "streaming Markdown animation stylesheet",
    skipDescription: "Markdown animation performance workaround",
    apply: applyLinuxMarkdownAnimationPerformancePatch,
  }),
];
