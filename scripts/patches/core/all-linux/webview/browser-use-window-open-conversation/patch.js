"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseWindowOpenConversationPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-browser-use-window-open-conversation",
  phase: "webview-asset",
  order: 1093,
  ciPolicy: "optional",
  pattern: /^app-initial~app-main~page-[^.]+\.js$/,
  missingDescription: "Browser new-tab conversation handler bundle",
  skipDescription: "Linux Browser window-open conversation patch",
  apply: applyLinuxBrowserUseWindowOpenConversationPatch,
});
