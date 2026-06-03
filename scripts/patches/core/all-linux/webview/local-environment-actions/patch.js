"use strict";

const {
  applyLocalEnvironmentActionModalDraftPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "local-environment-action-modal-draft",
    phase: "webview-asset",
    order: 1060,
    ciPolicy: "optional",
    pattern: /^local-conversation-thread-.*\.js$/,
    missingDescription: "local conversation thread bundle",
    skipDescription: "local environment action modal draft patch",
    apply: applyLocalEnvironmentActionModalDraftPatch,
  },
];
