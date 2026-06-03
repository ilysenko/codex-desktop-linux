"use strict";

const { applyLinuxProfileSettingsMenuPatch } = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-profile-settings-menu",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^profile-dropdown-.*\.js$/,
    missingDescription: "profile dropdown webview bundle",
    skipDescription: "Linux profile settings menu patch",
    apply: applyLinuxProfileSettingsMenuPatch,
  },
];
