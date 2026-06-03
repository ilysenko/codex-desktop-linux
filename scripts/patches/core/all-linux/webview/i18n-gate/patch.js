"use strict";

const { applyLinuxI18nGatePatch } = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-i18n-gate",
    phase: "webview-asset",
    order: 1042,
    ciPolicy: "optional",
    pattern: /^(app-main|general-settings)-.*\.js$/,
    missingDescription: "i18n-gated webview bundle",
    skipDescription: "Linux i18n gate patch",
    apply: applyLinuxI18nGatePatch,
  },
];
