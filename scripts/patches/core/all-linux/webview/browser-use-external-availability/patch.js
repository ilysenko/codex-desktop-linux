"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const { patchStatusFromChange } = require("../../../../../lib/patch-report.js");
const {
  patchLinuxBrowserUseExternalAvailabilityAssets,
} = require("../../../../impl/webview/index.js");

module.exports = extractedAppPatch({
  id: "linux-browser-use-external-availability",
  phase: "extracted-app:post-webview",
  order: 1990,
  ciPolicy: "optional",
  apply: patchLinuxBrowserUseExternalAvailabilityAssets,
  status: (result, warnings) => ({
    status: result?.matched === 0
      ? "skipped-optional"
      : patchStatusFromChange((result?.changed ?? 0) > 0, warnings),
    reason: result?.reason ?? warnings[0] ?? null,
  }),
});
