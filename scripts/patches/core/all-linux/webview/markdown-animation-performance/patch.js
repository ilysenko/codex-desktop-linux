"use strict";

const {
  CI_POLICY_OPTIONAL,
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxMarkdownAnimationPerformancePatch,
  matchesLinuxMarkdownAnimationPerformanceContract,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-markdown-animation-performance",
    phase: "webview-asset",
    order: 1047,
    ciPolicy: CI_POLICY_OPTIONAL,
    pattern: /^app-initial-[^.]+\.css$/,
    assetMatch: matchesLinuxMarkdownAnimationPerformanceContract,
    missingDescription: "streaming Markdown animation stylesheet",
    skipDescription: "Linux Markdown animation performance patch",
    apply: applyLinuxMarkdownAnimationPerformancePatch,
  }),
];
