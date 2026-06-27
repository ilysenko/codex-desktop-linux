"use strict";

const {
  applyLinuxAppServerFeatureEnablementPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-app-server-feature-enablement",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "optional",
    pattern: /^(?:(?:app-main|index)-|app-initial~app-main~).*\.js$/,
    missingDescription: "webview app main bundle",
    skipDescription: "app-server feature enablement compatibility patch",
    apply: applyLinuxAppServerFeatureEnablementPatch,
  },
];
