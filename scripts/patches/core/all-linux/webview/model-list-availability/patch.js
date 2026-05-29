"use strict";

const {
  applyLinuxModelListAvailabilityPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-model-list-availability",
    phase: "webview-asset",
    order: 1035,
    ciPolicy: "optional",
    pattern: /^model-queries-.*\.js$/,
    missingDescription: "model query bundle",
    skipDescription: "Linux model list availability patch",
    apply: applyLinuxModelListAvailabilityPatch,
  },
];
