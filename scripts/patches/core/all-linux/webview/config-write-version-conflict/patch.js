"use strict";

const {
  applyLinuxConfigWriteVersionConflictPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-config-write-version-conflict",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: "optional",
    pattern: /^(agent-settings|apps-availability|plugins-availability|use-plugin-install-flow|use-personality|experimental-features-queries|hooks-settings-queries|mcp-settings|personalization-settings|permissions-mode-helpers)-.*\.js$/,
    missingDescription: "config-writing webview bundle",
    skipDescription: "Linux config write version-conflict patch",
    apply: applyLinuxConfigWriteVersionConflictPatch,
  },
];
