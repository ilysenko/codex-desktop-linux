"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const { patchStatusFromChange } = require("../../../../../lib/patch-report.js");
const { patchLinuxAppUpdaterBridge } = require("../../../../../lib/linux-update-bridge-patch.js");

module.exports = [
  extractedAppPatch({
    id: "linux-app-updater-bridge",
    phase: "extracted-app:post-webview",
    order: 2000,
    ciPolicy: "optional",
    apply: (extractedDir) => patchLinuxAppUpdaterBridge(extractedDir),
    status: (result, warnings) => {
      if (result?.matched === 0) {
        return {
          status: "skipped-optional",
          reason: warnings[0] ?? "no matching bundle found",
        };
      }
      return {
        status: patchStatusFromChange((result?.changed ?? 0) > 0, warnings),
        reason: warnings[0] ?? null,
      };
    },
  }),
];
