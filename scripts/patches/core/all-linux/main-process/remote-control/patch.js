"use strict";

const {
  applyLinuxRemoteControlConfigPreservationPatch,
} = require("../../../../main-process.js");

module.exports = [
  {
    id: "linux-remote-control-config-preservation",
    phase: "main-bundle",
    order: 185,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlConfigPreservationPatch,
  },
];
