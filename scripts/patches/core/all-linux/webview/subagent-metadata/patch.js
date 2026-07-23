"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applySubagentNicknameMetadataPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "subagent-nickname-metadata-shape",
    phase: "webview-asset",
    order: 1050,
    ciPolicy: "required-upstream",
    pattern: /^app-initial-[^.]+\.js$/,
    missingDescription: "subagent metadata webview bundle",
    skipDescription: "subagent nickname metadata shape patch",
    apply: applySubagentNicknameMetadataPatch,
  }),
];
