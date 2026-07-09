"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxChatSearchHydrationPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-chat-search-hydration",
  phase: "webview-asset",
  order: 1092,
  ciPolicy: "optional",
  pattern: /^app-main-.*\.js$/,
  missingDescription: "webview app main bundle",
  skipDescription: "Linux chat search hydration patch",
  apply: applyLinuxChatSearchHydrationPatch,
});
