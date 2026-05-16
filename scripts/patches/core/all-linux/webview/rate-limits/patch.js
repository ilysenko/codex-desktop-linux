"use strict";

const {
  applyPersistentRateLimitFooterPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "composer-persistent-rate-limit-footer",
    phase: "webview-asset",
    order: 1050,
    ciPolicy: "optional",
    pattern: /^composer-.*\.js$/,
    missingDescription: "composer bundle",
    skipDescription: "persistent composer rate limit footer patch",
    apply: applyPersistentRateLimitFooterPatch,
  },
];
