"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseWebviewHostRecoveryPatch,
  applyLinuxBrowserUseWebviewRemountStorePatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-browser-use-webview-remount-store",
    phase: "webview-asset",
    order: 1093,
    ciPolicy: "optional",
    pattern: /^app-initial~artifact-tab-content\.electron~app-main~.*\.js$/,
    missingDescription: "Browser sidebar retained-webview store bundle",
    skipDescription: "Linux Browser sidebar remount store patch",
    apply: applyLinuxBrowserUseWebviewRemountStorePatch,
  }),
  webviewAssetPatch({
    id: "linux-browser-use-webview-attach-recovery",
    phase: "webview-asset",
    order: 1094,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~onboarding-page-[^.]+\.js$/,
    missingDescription: "Browser sidebar webview host bundle",
    skipDescription: "Linux Browser sidebar attachment recovery patch",
    apply: applyLinuxBrowserUseWebviewHostRecoveryPatch,
  }),
];
