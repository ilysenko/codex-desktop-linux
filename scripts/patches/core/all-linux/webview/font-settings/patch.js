"use strict";

const { applyLinuxSafeMonospaceFontStackPatch } = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-safe-monospace-font-stack",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: "optional",
    pattern: /^font-settings-.*\.js$/,
    missingDescription: "font settings bundle",
    skipDescription: "Linux monospace font stack patch",
    apply: applyLinuxSafeMonospaceFontStackPatch,
  },
];
