"use strict";

const { extractedAppPatch, webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  AUTOMATION_SCHEDULE_ASSET_NEEDLES,
  applyAutomationScheduleToApp,
  isAutomationScheduleCandidate,
} = require("./multi-time-rrule.js");
const {
  AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
} = require("./eager-update.js");

// Both owners live in rspack webview chunks with content-hashed names, so
// they are located by stable content needles plus a unique semantic contract.
module.exports = [
  extractedAppPatch({
    id: "multi-time-rrule",
    phase: "extracted-app:pre-webview",
    order: 20_100,
    ciPolicy: "optional",
    assetNeedles: AUTOMATION_SCHEDULE_ASSET_NEEDLES,
    assetMatch: isAutomationScheduleCandidate,
    missingDescription: "automation schedule bundle",
    skipDescription: "RRULE multi-time patch",
    apply: applyAutomationScheduleToApp,
  }),
  webviewAssetPatch({
    id: "eager-automation-update",
    phase: "webview-asset",
    order: 20_110,
    ciPolicy: "optional",
    assetNeedles: AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
    assetMatch: matchesAutomationUpdateEagerToolContract,
    missingDescription: "dynamic Codex app tools bundle",
    skipDescription: "automation_update eager dynamic tool patch",
    apply: applyAutomationUpdateEagerToolPatch,
  }),
];
