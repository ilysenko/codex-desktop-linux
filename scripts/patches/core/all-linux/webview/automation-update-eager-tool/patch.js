"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyAutomationUpdateEagerToolPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "automation-update-eager-tool",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: "optional",
    pattern: /\.js$/,
    missingDescription: "webview JavaScript bundle",
    skipDescription: "automation_update eager dynamic tool patch",
    apply: applyAutomationUpdateEagerToolPatch,
  }),
];
