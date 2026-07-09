"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxAppServerBackfillWaitPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-app-server-backfill-wait",
    phase: "webview-asset",
    order: 1042,
    ciPolicy: "optional",
    pattern: /^(app-server-manager|src)-.*\.js$/,
    missingDescription: "app-server manager webview bundle",
    skipDescription: "Linux app-server backfill wait patch",
    apply: applyLinuxAppServerBackfillWaitPatch,
  }),
];
