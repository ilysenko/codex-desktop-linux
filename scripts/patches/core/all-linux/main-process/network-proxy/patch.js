"use strict";

const {
  applyLinuxProxyAuthPatch,
} = require("../../../../main-process.js");

module.exports = [
  {
    id: "linux-proxy-auth",
    phase: "main-bundle",
    order: 125,
    ciPolicy: "optional",
    apply: applyLinuxProxyAuthPatch,
  },
];
