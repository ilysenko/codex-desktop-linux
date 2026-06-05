"use strict";

const {
  applyLinuxBrowserUseNonLocalNavigationPatch,
} = require("../../../../webview-assets.js");

module.exports = {
  id: "linux-browser-use-non-local-navigation",
  phase: "webview-asset",
  order: 1091,
  ciPolicy: "optional",
  pattern: /^app-main-.*\.js$/,
  missingDescription: "webview app main bundle",
  skipDescription: "Linux Browser Use non-local navigation patch",
  apply: applyLinuxBrowserUseNonLocalNavigationPatch,
};
