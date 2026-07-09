"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxSkillsListDedupePatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-skills-list-dedupe",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^(?:app-initial~app-main~|app-main-|index-).*\.js$/,
    missingDescription: "skills list webview bundle",
    skipDescription: "Linux skills list dedupe patch",
    apply: applyLinuxSkillsListDedupePatch,
  }),
];
