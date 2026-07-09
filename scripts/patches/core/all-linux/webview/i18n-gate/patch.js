"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const { applyLinuxI18nGatePatch } = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-i18n-gate",
    phase: "webview-asset",
    order: 1042,
    ciPolicy: "optional",
    pattern: /^(app-main|general-settings)-.*\.js$/,
    missingDescription: "i18n-gated webview bundle",
    skipDescription: "Linux i18n gate patch",
    apply: applyLinuxI18nGatePatch,
  }),
];
