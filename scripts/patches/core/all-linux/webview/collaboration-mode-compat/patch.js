"use strict";

const {
  applyLinuxCollaborationModeDefaultPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-collaboration-mode-default-compat",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: "optional",
    pattern: /^app-server-manager-signals-.*\.js$/,
    missingDescription: "webview app-server manager bundle",
    skipDescription: "collaboration mode default compatibility patch",
    apply: applyLinuxCollaborationModeDefaultPatch,
  },
];
