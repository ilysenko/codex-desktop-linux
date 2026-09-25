"use strict";

const { extractedAppPatch, webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const { patchAutomationScheduleAssets } = require("../../scripts/patches/impl/automation-schedule.js");
const {
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");

module.exports = [
  extractedAppPatch({
    id: "multi-time-rrule",
    phase: "extracted-app:pre-webview",
    order: 20_100,
    ciPolicy: "optional",
    apply: patchAutomationScheduleAssets,
  }),
  webviewAssetPatch({
    id: "eager-automation-update",
    phase: "webview-asset",
    order: 20_110,
    ciPolicy: "optional",
    pattern: /^app-shared-[^.]+\.js$/,
    assetMatch: matchesAutomationUpdateEagerToolContract,
    missingDescription: "dynamic Codex app tools bundle",
    skipDescription: "automation_update eager dynamic tool patch",
    apply: applyAutomationUpdateEagerToolPatch,
  }),
];
