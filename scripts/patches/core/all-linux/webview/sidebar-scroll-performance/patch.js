"use strict";

const {
  CI_POLICY_OPTIONAL,
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxSidebarScrollPerformancePatch,
  matchesLinuxSidebarScrollPerformanceContract,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-sidebar-scroll-performance",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: CI_POLICY_OPTIONAL,
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesLinuxSidebarScrollPerformanceContract,
    missingDescription: "main sidebar scroll bundle",
    skipDescription: "Linux sidebar scroll performance patch",
    apply: applyLinuxSidebarScrollPerformancePatch,
  }),
];
