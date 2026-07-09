"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const {
  patchAutomationScheduleAssets,
} = require("../../../../impl/automation-schedule.js");

module.exports = extractedAppPatch({
  id: "automation-schedule-multi-time-rrule",
  phase: "extracted-app:pre-webview",
  order: 240,
  ciPolicy: "optional",
  apply: patchAutomationScheduleAssets,
  status: (result, warnings) => ({
    status: result?.changed
      ? "applied"
      : warnings.length > 0
        ? "skipped-optional"
        : result?.matched
          ? "already-applied"
          : "skipped-optional",
    reason: result?.reason ?? warnings[0] ?? null,
  }),
});
