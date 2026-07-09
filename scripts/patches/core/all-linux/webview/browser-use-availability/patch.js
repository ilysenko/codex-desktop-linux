"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseAvailabilityPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-browser-use-availability",
  phase: "webview-asset",
  order: 1090,
  ciPolicy: "optional",
  pattern: /^(?:use-in-app-browser-use-availability-|use-is-plugins-enabled-|app-initial~app-main~).*\.js$/,
  missingDescription: "Browser Use availability bundle",
  skipDescription: "Linux Browser Use availability patch",
  apply: applyLinuxBrowserUseAvailabilityPatch,
});
