"use strict";

const {
  CI_POLICY_OPTIONAL,
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxAppShellTabLayoutPerformancePatch,
  matchesLinuxAppShellTabLayoutPerformanceContract,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-app-shell-tab-layout-performance",
    phase: "webview-asset",
    order: 1046,
    ciPolicy: CI_POLICY_OPTIONAL,
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesLinuxAppShellTabLayoutPerformanceContract,
    missingDescription: "app-shell tab layout bundle",
    skipDescription: "Linux app-shell tab layout performance patch",
    apply: applyLinuxAppShellTabLayoutPerformancePatch,
  }),
];
