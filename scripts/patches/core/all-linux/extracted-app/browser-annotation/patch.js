"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const { patchStatusFromChange } = require("../../../../../lib/patch-report.js");
const { patchCommentPreloadBundle } = require("../../../../impl/webview/index.js");

module.exports = [
  extractedAppPatch({
    id: "browser-annotation-screenshot",
    phase: "extracted-app:post-webview",
    order: 2010,
    ciPolicy: "optional",
    apply: (extractedDir) => patchCommentPreloadBundle(extractedDir),
    status: (result, warnings) => ({
      status: patchStatusFromChange(Boolean(result?.changed), warnings),
      reason: warnings[0] ?? null,
    }),
  }),
];
