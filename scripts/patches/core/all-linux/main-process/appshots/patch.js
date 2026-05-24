"use strict";

const {
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
} = require("../../../../appshots.js");

module.exports = [
  {
    id: "linux-appshots-main-process",
    phase: "main-bundle",
    order: 142,
    ciPolicy: "required-upstream",
    apply: applyLinuxAppshotMainProcessPatch,
  },
  {
    id: "linux-appshots-hotkey",
    phase: "main-bundle",
    order: 143,
    ciPolicy: "required-upstream",
    apply: applyLinuxAppshotHotkeyPatch,
  },
];
