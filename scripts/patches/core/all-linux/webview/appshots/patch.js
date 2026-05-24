"use strict";

const {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotSettingsHotkeyPatch,
} = require("../../../../appshots.js");

module.exports = [
  {
    id: "linux-appshots-availability",
    phase: "webview-asset",
    order: 1090,
    ciPolicy: "required-upstream",
    pattern: /^use-is-appshot-available-.*\.js$/,
    missingDescription: "AppShots availability bundle",
    skipDescription: "Linux AppShots availability patch",
    apply: applyLinuxAppshotAvailabilityPatch,
  },
  {
    id: "linux-appshots-settings-hotkey",
    phase: "webview-asset",
    order: 1091,
    ciPolicy: "required-upstream",
    pattern: /^appshots-settings-.*\.js$/,
    missingDescription: "AppShots settings bundle",
    skipDescription: "Linux AppShots settings hotkey patch",
    apply: applyLinuxAppshotSettingsHotkeyPatch,
  },
];
