"use strict";

const { applyLinuxFastModeModelGuardPatch } = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-fast-mode-model-guard",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "required-upstream",
    pattern: /^use-is-fast-mode-enabled-.*\.js$/,
    missingDescription: "fast-mode availability hook bundle",
    skipDescription: "fast-mode model guard patch",
    apply: applyLinuxFastModeModelGuardPatch,
  },
];
