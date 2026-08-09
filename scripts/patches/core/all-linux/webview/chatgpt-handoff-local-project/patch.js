"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxChatGptHandoffLocalProjectPatch,
  applyLinuxDesktopRequestGlobalPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-desktop-request-global",
    phase: "webview-asset",
    order: 1070,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    missingDescription: "app initial bundle",
    skipDescription: "Linux desktop request global patch",
    apply: applyLinuxDesktopRequestGlobalPatch,
  }),
  webviewAssetPatch({
    id: "linux-chatgpt-handoff-local-project",
    phase: "webview-asset",
    order: 1071,
    ciPolicy: "optional",
    pattern: /^use-chatgpt-composer-controller-[^.]+\.js$/,
    missingDescription: "ChatGPT composer controller bundle",
    skipDescription: "Linux ChatGPT handoff local project patch",
    apply: applyLinuxChatGptHandoffLocalProjectPatch,
  }),
];
