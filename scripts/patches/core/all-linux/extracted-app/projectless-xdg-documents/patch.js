"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const { patchProjectlessDocumentsAssets } = require("../../../../impl/projectless-documents.js");

module.exports = extractedAppPatch({
  id: "linux-projectless-xdg-documents-dir",
  phase: "extracted-app:pre-webview",
  order: 245,
  ciPolicy: "optional",
  apply: patchProjectlessDocumentsAssets,
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
