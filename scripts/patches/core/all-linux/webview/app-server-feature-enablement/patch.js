"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxAppServerFeatureEnablementPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-app-server-feature-enablement",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "optional",
    pattern: /^(?:(?:app-main|index)-|app-initial~app-main~).*\.js$/,
    missingDescription: "webview app main bundle",
    skipDescription: "app-server feature enablement compatibility patch",
    apply: applyLinuxAppServerFeatureEnablementPatch,
  }),
];
