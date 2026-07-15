"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseWebviewAttachRecoveryPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-browser-use-webview-attach-recovery",
  phase: "webview-asset",
  order: 1094,
  ciPolicy: "optional",
  pattern: /^app-initial~app-main~onboarding-page-[^.]+\.js$/,
  missingDescription: "Browser sidebar retained-webview store and host bundle",
  skipDescription: "Linux Browser sidebar attachment recovery patch",
  apply: applyLinuxBrowserUseWebviewAttachRecoveryPatch,
});
