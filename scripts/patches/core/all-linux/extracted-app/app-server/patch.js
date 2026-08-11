"use strict";

const { extractedAppPatch } = require("../../../../descriptor.js");
const {
  patchLinuxAppServerInitializeTimeout,
} = require("../../../../impl/main-process/app-server.js");

module.exports = [
  extractedAppPatch({
    id: "linux-app-server-initialize-timeout",
    phase: "extracted-app:pre-webview",
    order: 187,
    ciPolicy: "optional",
    apply: patchLinuxAppServerInitializeTimeout,
  }),
];
