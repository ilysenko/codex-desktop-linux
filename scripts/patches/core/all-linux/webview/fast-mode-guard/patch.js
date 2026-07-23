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
    // The current app keeps service-tier availability in the consolidated
    // app-initial bundle. Its current lookup no longer dereferences
    // serviceTiers, so applying the guard is intentionally a no-op.
    pattern: /^app-initial-[^.]+\.js$/,
    missingDescription: "fast-mode/service-tier availability bundle",
    skipDescription: "fast-mode model guard patch",
    apply: applyLinuxFastModeModelGuardPatch,
  }),
];
