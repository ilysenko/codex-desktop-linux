"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const { applyLinuxFastModeModelGuardPatch } = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-fast-mode-model-guard",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "required-upstream",
    // Older DMGs emit granular hook chunks; 26.623+ merges service-tier code
    // into the shared `app-initial~app-main~…` bundle (and switched to optional
    // chaining, so the guard is a no-op there). Match both shapes.
    pattern: /^(?:use-is-fast-mode-enabled|read-service-tier-for-request|use-service-tier-settings|app-server-manager-signals|app-initial~app-main~).*\.js$/,
    missingDescription: "fast-mode/service-tier availability bundle",
    skipDescription: "fast-mode model guard patch",
    apply: applyLinuxFastModeModelGuardPatch,
  }),
];
