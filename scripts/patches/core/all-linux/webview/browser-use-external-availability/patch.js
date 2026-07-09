"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseExternalAvailabilityPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-browser-use-external-availability",
  phase: "webview-asset",
  order: 1092,
  ciPolicy: "optional",
  pattern: /^(?:use-is-plugins-enabled|use-in-app-browser-use-availability)-.*\.js$|^app-initial~app-main~.*\.js$/,
  missingDescription: "external Browser Use availability bundle",
  skipDescription: "Linux external Browser Use availability patch",
  apply: applyLinuxBrowserUseExternalAvailabilityPatch,
});
