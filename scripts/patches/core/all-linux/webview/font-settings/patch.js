"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const { applyLinuxSafeMonospaceFontStackPatch } = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-safe-monospace-font-stack",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: "optional",
    pattern: /^(?:font-settings-.*|app-initial~app-main~remote-conversation-page~.*)\.js$/,
    missingDescription: "font settings bundle",
    skipDescription: "Linux monospace font stack patch",
    apply: applyLinuxSafeMonospaceFontStackPatch,
  }),
];
