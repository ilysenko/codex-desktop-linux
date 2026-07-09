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
    // Older DMGs emit granular hook chunks; 26.623+ merges them into the shared
    // `app-initial~app-main~…` bundle. Match both so the patch keeps targeting
    // the chunk that actually carries the subagent metadata module.
    pattern: /^(?:app-server-manager-signals|use-host-config|app-initial~app-main~).*\.js$/,
    missingDescription: "subagent metadata webview bundle",
    skipDescription: "subagent nickname metadata shape patch",
    apply: applySubagentNicknameMetadataPatch,
  }),
];
