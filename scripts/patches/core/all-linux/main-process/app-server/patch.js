"use strict";

const { mainBundlePatch } = require("../../../../descriptor.js");
const {
  applyLinuxAppServerInitializeTimeoutPatch,
} = require("../../../../impl/main-process/app-server.js");

module.exports = [
  mainBundlePatch({
    id: "linux-app-server-initialize-timeout",
    phase: "main-bundle",
    order: 186,
    ciPolicy: "optional",
    apply: applyLinuxAppServerInitializeTimeoutPatch,
  }),
];
