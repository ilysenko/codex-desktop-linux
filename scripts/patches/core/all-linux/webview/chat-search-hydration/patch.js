"use strict";

const {
  applyLinuxChatSearchHydrationPatch,
} = require("../../../../webview-assets.js");

module.exports = {
  id: "linux-chat-search-hydration",
  phase: "webview-asset",
  order: 1092,
  ciPolicy: "optional",
  pattern: /^app-main-.*\.js$/,
  missingDescription: "webview app main bundle",
  skipDescription: "Linux chat search hydration patch",
  apply: applyLinuxChatSearchHydrationPatch,
};
