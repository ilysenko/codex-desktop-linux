"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyPersistentRateLimitFooterPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "composer-persistent-rate-limit-footer",
    phase: "webview-asset",
    order: 1050,
    ciPolicy: "optional",
    pattern: /^composer-(?!external-footer).*\.js$/,
    missingDescription: "composer bundle",
    skipDescription: "persistent composer rate limit footer patch",
    apply: applyPersistentRateLimitFooterPatch,
  }),
];
