"use strict";

const { webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  applyLinuxMarkdownAnimationPerformancePatch,
  applyLinuxSidebarScrollPerformancePatch,
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
    id: "markdown-animation",
    phase: "webview-asset",
    order: 20_120,
    ciPolicy: "optional",
    pattern: /^app-primary-[^.]+\.css$/,
    assetMatch: matchesLinuxMarkdownAnimationPerformanceContract,
    missingDescription: "streaming Markdown animation stylesheet",
    skipDescription: "Markdown animation performance workaround",
    apply: applyLinuxMarkdownAnimationPerformancePatch,
  }),
];
