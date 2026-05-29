"use strict";

const {
  applyLinuxPluginListCompatibilityPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-plugin-list-compat",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "optional",
    pattern: /^(app-main|app-server-manager-signals)-.*\.js$/,
    missingDescription: "webview app-server protocol bundle",
    skipDescription: "plugin/list compatibility patch",
    apply: applyLinuxPluginListCompatibilityPatch,
  },
];
