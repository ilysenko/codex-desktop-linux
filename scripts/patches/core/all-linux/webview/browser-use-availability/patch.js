"use strict";

const {
  applyLinuxBrowserUseAvailabilityPatch,
} = require("../../../../webview-assets.js");

module.exports = {
  id: "linux-browser-use-availability",
  phase: "webview-asset",
  order: 1090,
  ciPolicy: "optional",
  pattern: /^(use-in-app-browser-use-availability|use-is-plugins-enabled)-.*\.js$/,
  missingDescription: "Browser Use availability bundle",
  skipDescription: "Linux Browser Use availability patch",
  apply: applyLinuxBrowserUseAvailabilityPatch,
};
