"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const { patchStatusFromChange } = require("../../../../../lib/patch-report.js");
const { patchLinuxOwlFeatureBindingFallbackAssets } = require("../../../../impl/main-process/misc.js");

module.exports = extractedAppPatch({
  id: "linux-owl-feature-binding-fallback",
  phase: "extracted-app:pre-webview",
  order: 190,
  ciPolicy: "required-upstream",
  apply: patchLinuxOwlFeatureBindingFallbackAssets,
  status: (result, warnings) => ({
    status: result?.matched === 0
      ? "failed-required"
      : patchStatusFromChange(Boolean(result?.changed), warnings, "required-upstream"),
    reason: result?.matched === 0
      ? "Owl feature binding loader bundle missing"
      : result?.reason ?? warnings[0] ?? null,
  }),
});
