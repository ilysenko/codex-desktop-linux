"use strict";

const { applyLinuxFastModeModelGuardPatch } = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-fast-mode-model-guard",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "required-upstream",
    pattern: /^(?:use-is-fast-mode-enabled|read-service-tier-for-request|use-service-tier-settings|app-server-manager-signals)-.*\.js$/,
    missingDescription: "fast-mode/service-tier availability bundle",
    skipDescription: "fast-mode model guard patch",
    apply: applyLinuxFastModeModelGuardPatch,
  },
];
