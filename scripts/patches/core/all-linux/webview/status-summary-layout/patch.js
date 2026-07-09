"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxStatusSummaryIntrinsicWidthPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-status-summary-intrinsic-width",
  phase: "webview-asset",
  order: 1070,
  ciPolicy: "optional",
  pattern: /^app-initial~app-main~.*editor-diff-page~thread-app.*\.js$/,
  missingDescription: "thread status summary bundle",
  skipDescription: "step and change-count status layout patch",
  apply: applyLinuxStatusSummaryIntrinsicWidthPatch,
});
