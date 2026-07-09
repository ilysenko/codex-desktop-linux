"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxAppServerConversationHydrationPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-app-server-conversation-hydration",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^(?:app-server-manager-signals|thread-context-inputs|app-initial~app-main~worktree-init-v2-page~remote-conversation-page~).*\.js$/,
    missingDescription: "app-server manager signals bundle",
    skipDescription: "Linux app-server conversation hydration patch",
    apply: applyLinuxAppServerConversationHydrationPatch,
  }),
];
