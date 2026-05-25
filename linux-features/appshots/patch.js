"use strict";

const {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  applyLinuxAppshotSettingsHotkeyPatch,
} = require("../../scripts/patches/appshots.js");

const descriptors = [
  {
    id: "linux-appshots-main-process",
    phase: "main-bundle",
    order: 142,
    apply: applyLinuxAppshotMainProcessPatch,
  },
  {
    id: "linux-appshots-hotkey",
    phase: "main-bundle",
    order: 143,
    apply: applyLinuxAppshotHotkeyPatch,
  },
  {
    id: "linux-appshots-availability",
    phase: "webview-asset",
    order: 1090,
    pattern: /^use-is-appshot-available-.*\.js$/,
    missingDescription: "AppShots availability bundle",
    skipDescription: "Linux AppShots availability patch",
    apply: applyLinuxAppshotAvailabilityPatch,
  },
  {
    id: "linux-appshots-settings-hotkey",
    phase: "webview-asset",
    order: 1091,
    pattern: /^appshots-settings-.*\.js$/,
    missingDescription: "AppShots settings bundle",
    skipDescription: "Linux AppShots settings hotkey patch",
    apply: applyLinuxAppshotSettingsHotkeyPatch,
  },
];

module.exports = {
  descriptors,
};
