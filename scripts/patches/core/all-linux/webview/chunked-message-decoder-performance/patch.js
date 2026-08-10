"use strict";

const {
  CI_POLICY_OPTIONAL,
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxChunkedMessageDecoderPerformancePatch,
  matchesLinuxChunkedMessageDecoderPerformanceContract,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-chunked-message-decoder-performance",
    phase: "webview-asset",
    order: 1047,
    ciPolicy: CI_POLICY_OPTIONAL,
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesLinuxChunkedMessageDecoderPerformanceContract,
    missingDescription: "chunked message decoder bundle",
    skipDescription: "Linux chunked message decoder performance patch",
    apply: applyLinuxChunkedMessageDecoderPerformancePatch,
  }),
];
