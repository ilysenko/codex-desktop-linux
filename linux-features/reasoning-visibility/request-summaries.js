"use strict";

const { prepareSummaryLayerSource, applySummaryLayer } = require("./summary-contract.js");

function applyRequestSummariesPatch(source) {
  try {
    return prepareSummaryLayerSource(source, "visibility").patchedSource;
  } catch (error) {
    console.warn(`WARN: reasoning-visibility/request-summaries: ${error.message}`);
    return source;
  }
}

function applyRequestSummariesExtractedAppPatch(extractedDir, context = {}) {
  return applySummaryLayer(extractedDir, "visibility", context.summaryRequestWriteOptions);
}

const requestSummariesDescriptor = {
  id: "request-summaries",
  phase: "extracted-app:pre-webview",
  order: 20_745,
  ciPolicy: "optional",
  apply: applyRequestSummariesExtractedAppPatch,
};

module.exports = { applyRequestSummariesPatch, applyRequestSummariesExtractedAppPatch, requestSummariesDescriptor };
