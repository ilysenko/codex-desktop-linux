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
    id: "linux-browser-use-webview-attach-recovery-store",
    phase: "webview-asset",
    order: 1094,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    missingDescription: "Browser sidebar retained-webview store bundle",
    skipDescription: "Linux Browser sidebar attachment recovery store patch",
    apply: applyLinuxBrowserUseWebviewRemountStorePatch,
  }),
  webviewAssetPatch({
    id: "linux-browser-use-webview-attach-recovery-host",
    phase: "webview-asset",
    order: 1095,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    missingDescription: "Browser sidebar retained-webview host bundle",
    skipDescription: "Linux Browser sidebar attachment recovery host patch",
    apply: applyLinuxBrowserUseWebviewHostRecoveryPatch,
  }),
];
