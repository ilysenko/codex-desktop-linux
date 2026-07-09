"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLocalEnvironmentActionModalDraftPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "local-environment-action-modal-draft",
    phase: "webview-asset",
    order: 1060,
    ciPolicy: "optional",
    pattern: /^local-conversation-thread-.*\.js$/,
    missingDescription: "local conversation thread bundle",
    skipDescription: "local environment action modal draft patch",
    apply: applyLocalEnvironmentActionModalDraftPatch,
  }),
];
