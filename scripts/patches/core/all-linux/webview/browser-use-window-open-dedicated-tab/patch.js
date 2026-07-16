"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseWindowOpenDedicatedTabPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-browser-use-window-open-dedicated-tab",
  phase: "webview-asset",
  order: 1094,
  ciPolicy: "optional",
  pattern: /^app-initial~app-main~page-[^.]+\.js$/,
  missingDescription: "Browser new-tab dedicated-tab classifier bundle",
  skipDescription: "Linux Browser window-open dedicated-tab patch",
  apply: applyLinuxBrowserUseWindowOpenDedicatedTabPatch,
});
