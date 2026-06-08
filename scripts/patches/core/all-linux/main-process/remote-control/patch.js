"use strict";

const {
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxRemoteControlDeviceKeyPatch,
} = require("../../../../main-process.js");

module.exports = [
  {
    id: "linux-remote-control-device-key",
    phase: "main-bundle",
    order: 184,
    ciPolicy: "optional",
    apply: applyLinuxRemoteControlDeviceKeyPatch,
  },
  {
    id: "linux-remote-control-config-preservation",
    phase: "main-bundle",
    order: 185,
    ciPolicy: "required-upstream",
    apply: applyLinuxRemoteControlConfigPreservationPatch,
  },
];
