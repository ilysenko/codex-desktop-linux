"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const { applyLinuxProfileSettingsMenuPatch } = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-profile-settings-menu",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^(?:profile-dropdown-.*|app-initial~app-main~automations-page-.*)\.js$/,
    missingDescription: "profile dropdown webview bundle",
    skipDescription: "Linux profile settings menu patch",
    apply: applyLinuxProfileSettingsMenuPatch,
  }),
];
