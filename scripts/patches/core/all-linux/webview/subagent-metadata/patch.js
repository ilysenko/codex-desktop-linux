"use strict";

const {
  applySubagentNicknameMetadataPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "subagent-nickname-metadata-shape",
    phase: "webview-asset",
    order: 1050,
    ciPolicy: "required-upstream",
    pattern: /^(?:app-server-manager-signals|use-host-config)-.*\.js$/,
    missingDescription: "subagent metadata webview bundle",
    skipDescription: "subagent nickname metadata shape patch",
    apply: applySubagentNicknameMetadataPatch,
  },
];
