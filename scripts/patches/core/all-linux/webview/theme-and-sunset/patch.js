"use strict";

const {
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-app-sunset-gate",
    phase: "webview-asset",
    order: 1000,
    ciPolicy: "required-upstream",
    pattern: /^index-.*\.js$/,
    missingDescription: "webview index bundle",
    skipDescription: "app sunset gate patch",
    apply: applyLinuxAppSunsetPatch,
  },
  {
    id: "opaque-window-default-general-settings",
    phase: "webview-asset",
    order: 1010,
    ciPolicy: "optional",
    pattern: /^general-settings-.*\.js$/,
    missingDescription: "general settings bundle",
    skipDescription: "translucent sidebar default patch",
    apply: applyLinuxOpaqueWindowsDefaultPatch,
  },
  {
    id: "opaque-window-default-webview-index",
    phase: "webview-asset",
    order: 1020,
    ciPolicy: "optional",
    pattern: /^(app-main|index)-.*\.js$/,
    missingDescription: "webview index bundle",
    skipDescription: "translucent sidebar default patch",
    apply: applyLinuxOpaqueWindowsDefaultPatch,
  },
  {
    id: "opaque-window-default-resolved-theme",
    phase: "webview-asset",
    order: 1030,
    ciPolicy: "optional",
    pattern: /^(diff-view-mode|use-resolved-theme-variant)-.*\.js$/,
    missingDescription: "resolved theme bundle",
    skipDescription: "translucent sidebar default patch",
    apply: applyLinuxOpaqueWindowsDefaultPatch,
  },
];
