"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxTurnStartDuplicateGuardPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-turn-start-duplicate-guard",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^(?:app-initial~app-main~(?:pull-request-code-review~)?onboarding-page~hotkey-window-thread-page~.*|app-server-manager-.*|src-.*)\.js$/,
    missingDescription: "turn/start request client webview bundle",
    skipDescription: "Linux turn/start duplicate submit guard",
    apply: applyLinuxTurnStartDuplicateGuardPatch,
  }),
];
