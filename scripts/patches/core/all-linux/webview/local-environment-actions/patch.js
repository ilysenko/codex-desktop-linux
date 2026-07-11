"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLocalEnvironmentActionModalDraftPatch,
  applyLocalEnvironmentEmptyProjectPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "local-environment-empty-project",
    phase: "webview-asset",
    order: 1059,
    ciPolicy: "required-upstream",
    pattern: /^local-environments-settings-page-.*\.js$/,
    missingDescription: "local environments settings page bundle",
    skipDescription: "local environment empty-project patch",
    apply: applyLocalEnvironmentEmptyProjectPatch,
  }),
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
